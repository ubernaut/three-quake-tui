// Three-Quake TUI entry point
// Renders Quake in the terminal via OpenTUI + Three.js WebGPU
//
// Usage: bun run tui.js
//   or:  npm start

// ============================================================================
// 1. Set up browser API shims BEFORE any engine imports
// ============================================================================

import './src/tui_shims.js';

// ============================================================================
// 2. Debug log to file (since terminal is used for rendering)
// ============================================================================

import { appendFileSync, writeFileSync, createReadStream } from 'node:fs';

const LOG_FILE = '/tmp/quake-tui.log';
writeFileSync( LOG_FILE, '' );
const runtimeDebug = process.env.QUAKE_TUI_DEBUG === '1' || process.env.QUAKE_TUI_INPUT_DEBUG === '1';

function log( ...args ) {

	const msg = args.map( a => typeof a === 'object' ? JSON.stringify( a ) : String( a ) ).join( ' ' );
	appendFileSync( LOG_FILE, new Date().toISOString().slice( 11, 23 ) + ' ' + msg + '\n' );

}

// ============================================================================
// 3. Import OpenTUI
// ============================================================================

import { createCliRenderer, OptimizedBuffer, Renderable } from '@opentui/core';
import { ThreeCliRenderer } from '@opentui/core/3d';
import * as THREE from 'three';

// ============================================================================
// 4. Import engine modules (after shims are in place)
// ============================================================================

import { Sys_Init, Sys_Printf } from './src/sys.js';
import { COM_InitArgv } from './src/common.js';
import { Host_Init, Host_Frame } from './src/host.js';
import { COM_FetchPak, COM_AddPack, COM_PreloadMaps } from './src/pak.js';
import { Cbuf_AddText } from './src/cmd.js';
import { scene, camera } from './src/gl_rmain.js';
import { Draw_GetOverlayCanvas } from './src/gl_draw.js';
import { Key_Event } from './src/keys.js';
import {
	key_dest, key_game, key_console, key_message, key_menu, keybindings,
	K_TAB, K_ENTER, K_ESCAPE, K_SPACE, K_BACKSPACE,
	K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW,
	K_ALT, K_CTRL, K_SHIFT,
	K_F1, K_F2, K_F3, K_F4, K_F5, K_F6, K_F7, K_F8, K_F9, K_F10, K_F11, K_F12,
	K_INS, K_DEL, K_PGDN, K_PGUP, K_HOME, K_END,
	K_MOUSE1, K_MOUSE2, K_MOUSE3, K_MWHEELUP, K_MWHEELDOWN
} from './src/keys.js';
import { con_forcedup } from './src/console.js';
import { cls, cl, SIGNONS } from './src/client.js';
import { in_forward, in_back, in_moveleft, in_moveright } from './src/cl_input.js';
import { IN_TuiInjectMouseDelta, IN_TuiSetMouseActive } from './src/in_web.js';

// ============================================================================
// Main
// ============================================================================

async function main() {

	try {

		log( 'Starting Three-Quake TUI' );

		Sys_Init();
		COM_InitArgv( [] );

		// ----------------------------------------------------------------
		// Load game data from filesystem
		// ----------------------------------------------------------------

		log( 'Loading pak0.pak...' );
		const pak0 = await COM_FetchPak( 'pak0.pak', 'pak0.pak', () => {} );

		if ( pak0 ) {

			COM_AddPack( pak0 );
			log( 'pak0.pak loaded successfully' );

		} else {

			console.error( 'pak0.pak not found - place the Quake shareware pak0.pak in the project root' );
			process.exit( 1 );

		}

		await COM_PreloadMaps( [
			'spinev2', 'rapture1', 'naked5', 'zed',
			'efdm9', 'baldm6', 'edc', 'ultrav'
		] );

		// ----------------------------------------------------------------
		// Initialize Quake engine
		// ----------------------------------------------------------------

		globalThis.__TUI_WIDTH = 320;
		globalThis.__TUI_HEIGHT = 240;

		log( 'Calling Host_Init...' );
		await Host_Init( { basedir: '.', argc: 0, argv: [] } );
		log( 'Host_Init complete' );
		if ( runtimeDebug ) installSignonTrace();

		Cbuf_AddText( 'map start\n' );
		for ( let i = 0; i < 10; i ++ ) {

			Host_Frame( 0.05 );
			// Allow async connect callbacks (e.g. "connect local") to run between frames.
			await Promise.resolve();

		}

		log( 'Scene:', scene ? scene.children.length + ' children' : 'null' );
		log( 'Camera:', camera ? 'exists' : 'null' );
		logInputState( 'PostInit' );

		// Add fill lighting for WebGPU rendering (Quake materials are very dark otherwise).
		if ( scene ) {

			scene.add( new THREE.AmbientLight( 0xffffff, 3.5 ) );
			const fillLight = new THREE.DirectionalLight( 0xffffff, 1.25 );
			fillLight.position.set( 0.25, 1, 0.5 );
			scene.add( fillLight );

		}

		// ----------------------------------------------------------------
		// Initialize OpenTUI
		// ----------------------------------------------------------------

			log( 'Creating CliRenderer...' );
			const cliRenderer = await createCliRenderer( {
				targetFps: 30,
				exitOnCtrlC: false,
				useMouse: true,
				enableMouseMovement: true,
				useAlternateScreen: true,
				// Enable parsed key events (including keyrelease when terminal supports it).
				useKittyKeyboard: {
					disambiguate: true,
					alternateKeys: true,
					events: true
				}
			} );

		const termW = cliRenderer.width;
		const termH = cliRenderer.height;
		// ThreeCliRenderer handles internal supersampling itself.
		const renderW = termW;
		const renderH = termH;

		log( 'Terminal:', termW, 'x', termH, '=> render:', renderW, 'x', renderH );

		// Create ThreeCliRenderer
		log( 'Creating ThreeCliRenderer...' );
		const threeRenderer = new ThreeCliRenderer( cliRenderer, {
			width: renderW,
			height: renderH,
			backgroundColor: { r: 0, g: 0, b: 0, a: 255 },
			autoResize: true
		} );

		await threeRenderer.init();
		log( 'ThreeCliRenderer initialized' );

		log( 'ThreeCliRenderer ready' );

			// Render scene into an offscreen buffer, then composite in post-process
			// so root renderables cannot overwrite the 3D frame.
			const sceneBuffer = OptimizedBuffer.create(
				termW,
				termH,
				cliRenderer.nextRenderBuffer.widthMethod,
				{ id: 'quake-scene-buffer' }
			);
			let sceneBufferReady = false;
			cliRenderer.on( 'destroy', () => sceneBuffer.destroy() );

			const mouseCapture = new MouseCaptureRenderable( cliRenderer, {
				id: 'quake-tui-mouse-capture',
				position: 'absolute',
				top: 0,
				left: 0,
				width: '100%',
				height: '100%',
				zIndex: 9999
			} );
			cliRenderer.root.add( mouseCapture );

		// ----------------------------------------------------------------
		// Terminal keyboard input
		// ----------------------------------------------------------------

			setupTerminalInput( cliRenderer );
			setupTerminalMouse( cliRenderer, mouseCapture );

		// ----------------------------------------------------------------
		// Game loop — render 3D scene in the async frame callback,
		// then requestRender to push to terminal
		// ----------------------------------------------------------------

		let lastTime = performance.now() / 1000;
		let frameCount = 0;

		cliRenderer.setFrameCallback( async ( deltaTime ) => {

			const now = performance.now() / 1000;
			const dt = Math.min( now - lastTime, 0.1 );
			lastTime = now;
			frameCount ++;

			// Update Quake engine (game logic, physics, scene graph)
			Host_Frame( dt );

			// Render Three.js scene to the terminal buffer via GPU
				if ( scene && camera ) {

					threeRenderer.setActiveCamera( camera );
					await threeRenderer.drawScene(
						scene,
						sceneBuffer,
						deltaTime
					);
					boostBufferExposure( sceneBuffer, 2.0, 0.9 );
					compositeOverlayIntoBuffer( sceneBuffer );
					sceneBufferReady = true;

			}

			if ( frameCount <= 3 || frameCount % 300 === 0 ) {
				log( 'Frame', frameCount,
					'scene:', scene ? scene.children.length + ' children' : 'null',
					'camera:', camera ? 'pos=' + camera.position.x.toFixed( 0 ) + ',' + camera.position.y.toFixed( 0 ) + ',' + camera.position.z.toFixed( 0 ) : 'null'
				);
				logInputState( 'FrameState' );

			}

		} );

		cliRenderer.addPostProcessFn( ( buffer ) => {

			if ( sceneBufferReady ) {

				buffer.drawFrameBuffer( 0, 0, sceneBuffer );

			}

		} );

		log( 'Starting render loop...' );
		cliRenderer.start();

	} catch ( e ) {

		log( 'FATAL ERROR:', e.message, e.stack );
		console.error( 'Three-Quake TUI Fatal Error:', e );
		process.exit( 1 );

	}

}

// ============================================================================
// Terminal keyboard input mapping
// ============================================================================

function setupTerminalInput( cliRenderer ) {

	const inputDebug = process.env.QUAKE_TUI_INPUT_DEBUG === '1';
	const fallbackTapReleaseRaw = Number.parseInt( process.env.QUAKE_TUI_TAP_RELEASE_MS || '28', 10 );
	const fallbackTapReleaseMs = Number.isFinite( fallbackTapReleaseRaw ) && fallbackTapReleaseRaw > 0
		? fallbackTapReleaseRaw
		: 28;
	const fallbackInitialHoldRaw = Number.parseInt( process.env.QUAKE_TUI_HOLD_INITIAL_MS || '240', 10 );
	const fallbackInitialHoldMs = Number.isFinite( fallbackInitialHoldRaw ) && fallbackInitialHoldRaw > 0
		? fallbackInitialHoldRaw
		: 240;
	const fallbackRepeatHoldRaw = Number.parseInt( process.env.QUAKE_TUI_HOLD_REPEAT_MS || '70', 10 );
	const fallbackRepeatHoldMs = Number.isFinite( fallbackRepeatHoldRaw ) && fallbackRepeatHoldRaw > 0
		? fallbackRepeatHoldRaw
		: 70;

	const parsedKeyMap = {
		escape: K_ESCAPE,
		return: K_ENTER,
		enter: K_ENTER,
		tab: K_TAB,
		backspace: K_BACKSPACE,
		space: K_SPACE,
		up: K_UPARROW,
		down: K_DOWNARROW,
		left: K_LEFTARROW,
		right: K_RIGHTARROW,
		alt: K_ALT,
		ctrl: K_CTRL,
		control: K_CTRL,
		shift: K_SHIFT,
		f1: K_F1,
		f2: K_F2,
		f3: K_F3,
		f4: K_F4,
		f5: K_F5,
		f6: K_F6,
		f7: K_F7,
		f8: K_F8,
		f9: K_F9,
		f10: K_F10,
		f11: K_F11,
		f12: K_F12,
		insert: K_INS,
		delete: K_DEL,
		del: K_DEL,
		pageup: K_PGUP,
		pagedown: K_PGDN,
		home: K_HOME,
		end: K_END
	};

	const rawKeyMap = {
		'\x1b': K_ESCAPE,
		'\r': K_ENTER,
		'\n': K_ENTER,
		'\t': K_TAB,
		'\x7f': K_BACKSPACE,
		'\b': K_BACKSPACE,
		' ': K_SPACE,
		'\x1b[A': K_UPARROW,
		'\x1b[B': K_DOWNARROW,
		'\x1b[C': K_RIGHTARROW,
		'\x1b[D': K_LEFTARROW,
		'\x1bOP': K_F1,
		'\x1bOQ': K_F2,
		'\x1bOR': K_F3,
		'\x1bOS': K_F4,
		'\x1b[15~': K_F5,
		'\x1b[17~': K_F6,
		'\x1b[18~': K_F7,
		'\x1b[19~': K_F8,
		'\x1b[20~': K_F9,
		'\x1b[21~': K_F10,
		'\x1b[23~': K_F11,
		'\x1b[24~': K_F12,
		'\x1b[2~': K_INS,
		'\x1b[3~': K_DEL,
		'\x1b[5~': K_PGUP,
		'\x1b[6~': K_PGDN,
		'\x1b[H': K_HOME,
		'\x1b[F': K_END
	};

	const pressedKeys = new Set();
	const releaseTimers = new Map();
	let hasKeyReleaseEvents = false;

	function clearReleaseTimer( key ) {

		const timer = releaseTimers.get( key );
		if ( timer ) {

			clearTimeout( timer );
			releaseTimers.delete( key );

		}

	}

	function clearAllReleaseTimers() {

		for ( const timer of releaseTimers.values() ) clearTimeout( timer );
		releaseTimers.clear();

	}

	function releasePressedKeys() {

		for ( const key of Array.from( pressedKeys ) ) releaseKey( key );

	}

	function isHoldBindingKey( key ) {

		const binding = keybindings[ key ];
		return typeof binding === 'string' && binding.startsWith( '+' );

	}

	function getFallbackReleaseMs( key, isRepeatKeyPress ) {

		if ( ! isHoldBindingKey( key ) ) return fallbackTapReleaseMs;

		return isRepeatKeyPress ? fallbackRepeatHoldMs : fallbackInitialHoldMs;

	}

	function scheduleReleaseFallback( key, delayMs ) {

		if ( hasKeyReleaseEvents ) return;

		clearReleaseTimer( key );
		const timer = setTimeout( () => {

			releaseTimers.delete( key );
			if ( pressedKeys.has( key ) ) {

				pressedKeys.delete( key );
				Key_Event( key, false );

			}

		}, delayMs );
		releaseTimers.set( key, timer );

	}

	function releaseKey( key ) {

		clearReleaseTimer( key );
		if ( pressedKeys.has( key ) ) {

			pressedKeys.delete( key );
			if ( inputDebug ) log( 'Key up:', key );
			Key_Event( key, false );

		}

	}

	function pressKey( key ) {

		const alreadyPressed = pressedKeys.has( key );
		if ( ! pressedKeys.has( key ) ) {

			pressedKeys.add( key );
			if ( inputDebug ) log( 'Key down:', key );
			Key_Event( key, true );

		}

		// Fallback for terminals that do not emit keyrelease events.
		if ( ! hasKeyReleaseEvents ) scheduleReleaseFallback( key, getFallbackReleaseMs( key, alreadyPressed ) );

	}

	function toQuakeKey( event ) {

		const name = event && event.name ? String( event.name ).toLowerCase() : '';
		if ( parsedKeyMap[ name ] !== undefined ) return parsedKeyMap[ name ];

		const text = typeof event.sequence === 'string' && event.sequence.length === 1
			? event.sequence
			: ( name.length === 1 ? name : null );
		if ( text ) {

			const code = text.charCodeAt( 0 );
			if ( code >= 32 && code <= 126 ) return code;

		}

		return undefined;

	}

	function handleCtrlC() {

		cleanup();
		cliRenderer.destroy();
		process.exit( 0 );

	}

	function handleRawSequence( sequence ) {

		if ( typeof sequence !== 'string' || sequence.length === 0 ) return false;

		if ( sequence === '\x03' ) {

			handleCtrlC();
			return true;

		}

		// Kitty keyboard sequences are already emitted by keyInput.
		if ( sequence.startsWith( '\x1b[' ) && sequence.endsWith( 'u' ) ) return false;

		const quakeKey = rawKeyMap[ sequence ];
		if ( quakeKey !== undefined ) {

			pressKey( quakeKey );
			return true;

		}

		if ( sequence.length === 1 ) {

			const code = sequence.charCodeAt( 0 );
			if ( code >= 32 && code <= 126 ) {

				pressKey( code );
				return true;

			}

		}

		return false;

	}

	const onKeyPress = ( event ) => {

		if ( event && event.ctrl && event.name === 'c' ) {

			handleCtrlC();
			return;

		}

		const quakeKey = toQuakeKey( event );
		if ( quakeKey === undefined ) return;
		if ( inputDebug ) log( 'Parsed keypress:', event.name, 'seq=', JSON.stringify( event.sequence ) );
		if ( inputDebug ) logInputState( 'KeyPressState' );
		pressKey( quakeKey );

	};

	const onKeyRelease = ( event ) => {

		const quakeKey = toQuakeKey( event );
		if ( quakeKey === undefined ) return;
		if ( ! hasKeyReleaseEvents ) {

			hasKeyReleaseEvents = true;
			clearAllReleaseTimers();
			if ( inputDebug ) log( 'Detected keyrelease support from terminal' );

		}
		if ( inputDebug ) log( 'Parsed keyrelease:', event.name, 'seq=', JSON.stringify( event.sequence ) );
		releaseKey( quakeKey );

	};

	const onBlur = () => releasePressedKeys();

	const onSigInt = () => handleCtrlC();
	const onSigTerm = () => handleCtrlC();

	function cleanup() {

		cliRenderer.removeInputHandler( handleRawSequence );
		cliRenderer.keyInput.off( 'keypress', onKeyPress );
		cliRenderer.keyInput.off( 'keyrelease', onKeyRelease );
		cliRenderer.off( 'blur', onBlur );
		process.off( 'SIGINT', onSigInt );
		process.off( 'SIGTERM', onSigTerm );
		clearAllReleaseTimers();
		releasePressedKeys();
		hasKeyReleaseEvents = false;

	}

	cliRenderer.addInputHandler( handleRawSequence );
	cliRenderer.keyInput.on( 'keypress', onKeyPress );
	cliRenderer.keyInput.on( 'keyrelease', onKeyRelease );
	cliRenderer.on( 'blur', onBlur );
	process.on( 'SIGINT', onSigInt );
	process.on( 'SIGTERM', onSigTerm );
	cliRenderer.on( 'destroy', cleanup );

}

class MouseCaptureRenderable extends Renderable {

	renderSelf() {}

}

function setupTerminalMouse( cliRenderer, mouseCapture ) {

	const inputDebug = process.env.QUAKE_TUI_INPUT_DEBUG === '1';
	const enableMouseLook = process.env.QUAKE_TUI_MOUSE_LOOK !== '0';
	const cellScaleRaw = Number.parseFloat( process.env.QUAKE_TUI_MOUSE_CELL_SCALE || '20' );
	const cellScale = Number.isFinite( cellScaleRaw ) && cellScaleRaw > 0 ? cellScaleRaw : 20;
	const useRawMouse = process.env.QUAKE_TUI_RAW_MOUSE === '1';
	const rawMouseDevice = process.env.QUAKE_TUI_RAW_MOUSE_DEVICE || '/dev/input/mice';
	const rawMouseScaleRaw = Number.parseFloat( process.env.QUAKE_TUI_RAW_MOUSE_SCALE || '1.4' );
	const rawMouseScale = Number.isFinite( rawMouseScaleRaw ) && rawMouseScaleRaw > 0 ? rawMouseScaleRaw : 1.4;

	let lastX = null;
	let lastY = null;
	let rawMouseActive = false;
	let rawMouseErrorLogged = false;
	let rendererFocused = true;
	const pressedMouseKeys = new Set();
	let rawMouseCleanup = () => {};

	function toQuakeMouseKey( button ) {

		switch ( button ) {

			case 0: return K_MOUSE1;
			case 2: return K_MOUSE2;
			case 1: return K_MOUSE3;
			default: return undefined;

		}

	}

	function pressMouseKey( key ) {

		if ( pressedMouseKeys.has( key ) ) return;
		pressedMouseKeys.add( key );
		Key_Event( key, true );

	}

	function setMouseKeyState( key, isDown ) {

		if ( isDown ) {

			pressMouseKey( key );
			return;

		}

		releaseMouseKey( key );

	}

	function releaseMouseKey( key ) {

		if ( pressedMouseKeys.has( key ) ) {

			pressedMouseKeys.delete( key );
			Key_Event( key, false );

		}

	}

	function applyLookDelta( event ) {

		if ( rawMouseActive ) {

			lastX = event.x;
			lastY = event.y;
			return;

		}

		if ( ! enableMouseLook || key_dest !== key_game ) {

			lastX = event.x;
			lastY = event.y;
			return;

		}

		if ( lastX === null || lastY === null ) {

			lastX = event.x;
			lastY = event.y;
			return;

		}

		const dx = ( event.x - lastX ) * cellScale;
		const dy = ( event.y - lastY ) * cellScale;
		lastX = event.x;
		lastY = event.y;

		if ( dx !== 0 || dy !== 0 ) {

			IN_TuiInjectMouseDelta( dx, dy );
			if ( inputDebug ) log( 'Mouse look delta:', dx.toFixed( 1 ), dy.toFixed( 1 ) );

		}

	}

	function injectRawLookDelta( dx, dy ) {

		if ( ! enableMouseLook || key_dest !== key_game || ! rendererFocused ) return;
		if ( dx === 0 && dy === 0 ) return;

		const sx = dx * rawMouseScale;
		const sy = dy * rawMouseScale;
		IN_TuiInjectMouseDelta( sx, sy );
		if ( inputDebug ) log( 'Raw mouse look delta:', sx.toFixed( 1 ), sy.toFixed( 1 ) );

	}

	function setupRawMouseReader() {

		if ( ! useRawMouse ) return () => {};
		if ( inputDebug ) log( 'Raw mouse requested path=', rawMouseDevice, 'scale=', rawMouseScale );

		let stream;
		let remainder = Buffer.alloc( 0 );

		function onData( chunk ) {

			const chunkBuffer = Buffer.isBuffer( chunk ) ? chunk : Buffer.from( chunk );
			const data = remainder.length === 0 ? chunkBuffer : Buffer.concat( [ remainder, chunkBuffer ] );
			let offset = 0;

			while ( offset + 3 <= data.length ) {

				const b0 = data[ offset ];
				const b1 = data[ offset + 1 ];
				const b2 = data[ offset + 2 ];
				offset += 3;

				// Ignore malformed packets that do not have the sync bit set.
				if ( ( b0 & 0x08 ) === 0 ) continue;

				const dx = ( b1 << 24 ) >> 24;
				// In PS/2 packets positive Y means up; invert to make down positive.
				const dy = - ( ( b2 << 24 ) >> 24 );
				injectRawLookDelta( dx, dy );

				setMouseKeyState( K_MOUSE1, ( b0 & 0x01 ) !== 0 );
				setMouseKeyState( K_MOUSE2, ( b0 & 0x02 ) !== 0 );
				setMouseKeyState( K_MOUSE3, ( b0 & 0x04 ) !== 0 );

			}

			remainder = offset < data.length ? data.slice( offset ) : Buffer.alloc( 0 );

		}

		function onOpen() {

			rawMouseActive = true;
			rawMouseErrorLogged = false;
			log( 'Raw mouse active:', rawMouseDevice );

		}

		function onError( error ) {

			rawMouseActive = false;
			if ( rawMouseErrorLogged ) return;
			rawMouseErrorLogged = true;
			log( 'Raw mouse unavailable:', rawMouseDevice, error && error.message ? error.message : String( error ) );

		}

		function onClose() {

			rawMouseActive = false;
			remainder = Buffer.alloc( 0 );

		}

		try {

			stream = createReadStream( rawMouseDevice, { flags: 'r' } );

		} catch ( error ) {

			onError( error );
			return () => {};

		}

		stream.on( 'open', onOpen );
		stream.on( 'data', onData );
		stream.on( 'error', onError );
		stream.on( 'close', onClose );

		return () => {

			if ( ! stream ) return;
			stream.off( 'open', onOpen );
			stream.off( 'data', onData );
			stream.off( 'error', onError );
			stream.off( 'close', onClose );
			try {

				stream.destroy();

			} catch ( e ) { /* ignore */ }
			stream = null;
			rawMouseActive = false;

		};

	}

	mouseCapture.onMouseDown = ( event ) => {

		lastX = event.x;
		lastY = event.y;
		if ( rawMouseActive ) return;
		const key = toQuakeMouseKey( event.button );
		if ( key !== undefined ) {

			if ( inputDebug ) log( 'Mouse down:', event.button, '->', key );
			pressMouseKey( key );
			event.preventDefault();

		}

	};

	mouseCapture.onMouseUp = ( event ) => {

		lastX = event.x;
		lastY = event.y;
		if ( rawMouseActive ) return;
		const key = toQuakeMouseKey( event.button );
		if ( key !== undefined ) {

			if ( inputDebug ) log( 'Mouse up:', event.button, '->', key );
			releaseMouseKey( key );
			event.preventDefault();

		}

	};

	mouseCapture.onMouseMove = ( event ) => {

		applyLookDelta( event );

	};

	mouseCapture.onMouseDrag = ( event ) => {

		applyLookDelta( event );

	};

	mouseCapture.onMouseScroll = ( event ) => {

		if ( ! event.scroll ) return;

		if ( inputDebug ) log( 'Mouse scroll:', event.scroll.direction, 'delta=', event.scroll.delta );
		if ( event.scroll.direction === 'up' ) {

			Key_Event( K_MWHEELUP, true );
			Key_Event( K_MWHEELUP, false );
			event.preventDefault();
			return;

		}

		if ( event.scroll.direction === 'down' ) {

			Key_Event( K_MWHEELDOWN, true );
			Key_Event( K_MWHEELDOWN, false );
			event.preventDefault();

		}

	};

	mouseCapture.onMouseOut = () => {

		lastX = null;
		lastY = null;

	};

	rawMouseCleanup = setupRawMouseReader();

	const onFocus = () => { rendererFocused = true; };
	const onBlur = () => {

		rendererFocused = false;
		lastX = null;
		lastY = null;

	};
	cliRenderer.on( 'focus', onFocus );
	cliRenderer.on( 'blur', onBlur );

	IN_TuiSetMouseActive( true );

	function cleanup() {

		IN_TuiSetMouseActive( false );
		rawMouseCleanup();
		rawMouseCleanup = () => {};
		mouseCapture.onMouseDown = undefined;
		mouseCapture.onMouseUp = undefined;
		mouseCapture.onMouseMove = undefined;
		mouseCapture.onMouseDrag = undefined;
		mouseCapture.onMouseScroll = undefined;
		mouseCapture.onMouseOut = undefined;
		for ( const key of pressedMouseKeys ) Key_Event( key, false );
			pressedMouseKeys.clear();
			lastX = null;
			lastY = null;
			rawMouseActive = false;
			rendererFocused = false;
			cliRenderer.off( 'focus', onFocus );
			cliRenderer.off( 'blur', onBlur );

	}

	cliRenderer.on( 'destroy', cleanup );

}

function keyDestName( value ) {

	switch ( value ) {

		case key_game: return 'game';
		case key_console: return 'console';
		case key_message: return 'message';
		case key_menu: return 'menu';
		default: return String( value );

	}

}

function logInputState( prefix = 'State' ) {

	if ( ! runtimeDebug ) return;

	log(
		prefix,
		'key_dest=', keyDestName( key_dest ),
		'forcedup=', con_forcedup ? '1' : '0',
		'signon=', cls.signon + '/' + SIGNONS,
		'cls.state=', cls.state,
		'world=', cl.worldmodel ? 'yes' : 'no',
		'bind[w]=', keybindings[ 119 ] || '(none)',
		'in_fwd=', in_forward.state,
		'in_back=', in_back.state,
		'in_left=', in_moveleft.state,
		'in_right=', in_moveright.state
	);

}

function boostBufferExposure( buffer, gain = 1.0, gamma = 1.0 ) {

	const fg = buffer.buffers.fg;
	const bg = buffer.buffers.bg;

	for ( let i = 0; i < fg.length; i += 4 ) {

		fg[ i ] = Math.min( 1, Math.pow( Math.max( 0, fg[ i ] * gain ), gamma ) );
		fg[ i + 1 ] = Math.min( 1, Math.pow( Math.max( 0, fg[ i + 1 ] * gain ), gamma ) );
		fg[ i + 2 ] = Math.min( 1, Math.pow( Math.max( 0, fg[ i + 2 ] * gain ), gamma ) );

		bg[ i ] = Math.min( 1, Math.pow( Math.max( 0, bg[ i ] * gain ), gamma ) );
		bg[ i + 1 ] = Math.min( 1, Math.pow( Math.max( 0, bg[ i + 1 ] * gain ), gamma ) );
		bg[ i + 2 ] = Math.min( 1, Math.pow( Math.max( 0, bg[ i + 2 ] * gain ), gamma ) );

	}

}

const HALF_BLOCK_CODEPOINT = 0x2580;

function compositeOverlayIntoBuffer( buffer ) {

	const overlayCanvas = Draw_GetOverlayCanvas();
	if ( ! overlayCanvas || ! overlayCanvas._pixels ) return;

	const srcPixels = overlayCanvas._pixels;
	const srcW = overlayCanvas.width | 0;
	const srcH = overlayCanvas.height | 0;
	if ( srcW <= 0 || srcH <= 0 ) return;

	const dstW = buffer.width;
	const dstH = buffer.height;
	const fg = buffer.buffers.fg;
	const bg = buffer.buffers.bg;
	const chars = buffer.buffers.char;
	const xScale = srcW / dstW;
	const yScale = srcH / ( dstH * 2 );

	for ( let y = 0; y < dstH; y ++ ) {

		const srcTopY = Math.min( srcH - 1, Math.floor( ( y * 2 + 0.5 ) * yScale ) );
		const srcBottomY = Math.min( srcH - 1, Math.floor( ( y * 2 + 1.5 ) * yScale ) );
		const topRow = srcTopY * srcW * 4;
		const bottomRow = srcBottomY * srcW * 4;
		const dstRow = y * dstW * 4;

		for ( let x = 0; x < dstW; x ++ ) {

			const srcX = Math.min( srcW - 1, Math.floor( ( x + 0.5 ) * xScale ) );
			const topIdx = topRow + srcX * 4;
			const bottomIdx = bottomRow + srcX * 4;
			const dstIdx = dstRow + x * 4;
			const cellIdx = y * dstW + x;
			let overlayApplied = false;

			const topAlpha = srcPixels[ topIdx + 3 ] / 255;
			if ( topAlpha > 0 ) {

				const invTop = 1 - topAlpha;
				fg[ dstIdx ] = fg[ dstIdx ] * invTop + ( srcPixels[ topIdx ] / 255 ) * topAlpha;
				fg[ dstIdx + 1 ] = fg[ dstIdx + 1 ] * invTop + ( srcPixels[ topIdx + 1 ] / 255 ) * topAlpha;
				fg[ dstIdx + 2 ] = fg[ dstIdx + 2 ] * invTop + ( srcPixels[ topIdx + 2 ] / 255 ) * topAlpha;
				overlayApplied = true;

			}

			const bottomAlpha = srcPixels[ bottomIdx + 3 ] / 255;
			if ( bottomAlpha > 0 ) {

				const invBottom = 1 - bottomAlpha;
				bg[ dstIdx ] = bg[ dstIdx ] * invBottom + ( srcPixels[ bottomIdx ] / 255 ) * bottomAlpha;
				bg[ dstIdx + 1 ] = bg[ dstIdx + 1 ] * invBottom + ( srcPixels[ bottomIdx + 1 ] / 255 ) * bottomAlpha;
				bg[ dstIdx + 2 ] = bg[ dstIdx + 2 ] * invBottom + ( srcPixels[ bottomIdx + 2 ] / 255 ) * bottomAlpha;
				overlayApplied = true;

			}

			if ( overlayApplied && chars[ cellIdx ] === 32 ) {

				chars[ cellIdx ] = HALF_BLOCK_CODEPOINT;

			}

		}

	}

}

function installSignonTrace() {

	let current = cls.signon;
	let transitions = 0;
	const descriptor = Object.getOwnPropertyDescriptor( cls, 'signon' );
	if ( descriptor && descriptor.configurable === false ) return;

	Object.defineProperty( cls, 'signon', {
		configurable: true,
		enumerable: true,
		get() {

			return current;

		},
		set( value ) {

			if ( value !== current ) {

				transitions ++;
				if ( transitions <= 20 || value === 0 ) {

					const err = new Error();
					const stack = ( err.stack || '' ).split( '\n' ).slice( 2, 6 ).map( s => s.trim() ).join( ' | ' );
					log( 'SignonTransition', current + '->' + value, stack );

				}

				current = value;

			}

		}
	} );

}

main();
