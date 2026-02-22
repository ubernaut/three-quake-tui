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

import { appendFileSync, writeFileSync } from 'node:fs';

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

import { createCliRenderer, OptimizedBuffer } from '@opentui/core';
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
import { Key_Event } from './src/keys.js';
import {
	key_dest, key_game, key_console, key_message, key_menu, keybindings,
	K_TAB, K_ENTER, K_ESCAPE, K_SPACE, K_BACKSPACE,
	K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW,
	K_ALT, K_CTRL, K_SHIFT,
	K_F1, K_F2, K_F3, K_F4, K_F5, K_F6, K_F7, K_F8, K_F9, K_F10, K_F11, K_F12,
	K_INS, K_DEL, K_PGDN, K_PGUP, K_HOME, K_END
} from './src/keys.js';
import { con_forcedup } from './src/console.js';
import { cls, cl, SIGNONS } from './src/client.js';
import { in_forward, in_back, in_moveleft, in_moveright } from './src/cl_input.js';

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
			useMouse: false,
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

		// ----------------------------------------------------------------
		// Terminal keyboard input
		// ----------------------------------------------------------------

		setupTerminalInput( cliRenderer );

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
	const knownRawEscapeSequences = Object.keys( rawKeyMap )
		.filter( s => s.startsWith( '\x1b' ) )
		.sort( ( a, b ) => b.length - a.length );

	const pressedKeys = new Set();
	const releaseTimers = new Map();
	let pendingRaw = '';

	function clearReleaseTimer( key ) {

		const timer = releaseTimers.get( key );
		if ( timer ) {

			clearTimeout( timer );
			releaseTimers.delete( key );

		}

	}

	function scheduleReleaseFallback( key ) {

		clearReleaseTimer( key );
		const timer = setTimeout( () => {

			releaseTimers.delete( key );
			if ( pressedKeys.has( key ) ) {

				pressedKeys.delete( key );
				Key_Event( key, false );

			}

		}, 180 );
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

		if ( ! pressedKeys.has( key ) ) {

			pressedKeys.add( key );
			if ( inputDebug ) log( 'Key down:', key );
			Key_Event( key, true );

		}

		// Fallback for terminals that do not emit keyrelease events.
		scheduleReleaseFallback( key );

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

		if ( sequence === '\x03' ) {

			handleCtrlC();
			return true;

		}

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

	function feedRawInput( chunk ) {

		pendingRaw += chunk;
		while ( pendingRaw.length > 0 ) {

			// Non-escape single byte.
			if ( pendingRaw[ 0 ] !== '\x1b' ) {

				const ch = pendingRaw[ 0 ];
				pendingRaw = pendingRaw.slice( 1 );
				handleRawSequence( ch );
				continue;

			}

			let matched = false;
			for ( const seq of knownRawEscapeSequences ) {

				if ( pendingRaw.startsWith( seq ) ) {

					pendingRaw = pendingRaw.slice( seq.length );
					handleRawSequence( seq );
					matched = true;
					break;

				}

			}

			if ( matched ) continue;

			const maybePartial = knownRawEscapeSequences.some( seq => seq.startsWith( pendingRaw ) );
			if ( maybePartial ) break;

			// Unknown escape payload: at least consume ESC.
			handleRawSequence( '\x1b' );
			pendingRaw = pendingRaw.slice( 1 );

		}

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
		if ( inputDebug ) log( 'Parsed keyrelease:', event.name, 'seq=', JSON.stringify( event.sequence ) );
		releaseKey( quakeKey );

	};

	const onRawStdin = ( data ) => {

		const chunk = typeof data === 'string' ? data : String( data );
		if ( inputDebug ) log( 'stdin chunk:', JSON.stringify( chunk ) );
		feedRawInput( chunk );

	};

	const onSigInt = () => handleCtrlC();
	const onSigTerm = () => handleCtrlC();

	function cleanup() {

		cliRenderer.removeInputHandler( handleRawSequence );
		cliRenderer.keyInput.off( 'keypress', onKeyPress );
		cliRenderer.keyInput.off( 'keyrelease', onKeyRelease );
		process.stdin.off( 'data', onRawStdin );
		process.off( 'SIGINT', onSigInt );
		process.off( 'SIGTERM', onSigTerm );
		for ( const timer of releaseTimers.values() ) clearTimeout( timer );
		releaseTimers.clear();
		for ( const key of pressedKeys ) Key_Event( key, false );
		pressedKeys.clear();
		pendingRaw = '';

	}

	cliRenderer.addInputHandler( handleRawSequence );
	cliRenderer.keyInput.on( 'keypress', onKeyPress );
	cliRenderer.keyInput.on( 'keyrelease', onKeyRelease );
	process.stdin.on( 'data', onRawStdin );
	process.on( 'SIGINT', onSigInt );
	process.on( 'SIGTERM', onSigTerm );
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
