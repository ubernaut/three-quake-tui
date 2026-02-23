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
const perfDebug = process.env.QUAKE_TUI_PERF_DEBUG === '1';
const perfSpikeThresholdMsRaw = Number.parseFloat( process.env.QUAKE_TUI_PERF_SPIKE_MS || '45' );
const perfSpikeThresholdMs = Number.isFinite( perfSpikeThresholdMsRaw ) && perfSpikeThresholdMsRaw > 0
	? perfSpikeThresholdMsRaw
	: 45;
let _uvSanitizeRequested = true;
let _precompilePassSerial = 0;

function log( ...args ) {

	const msg = args.map( a => typeof a === 'object' ? JSON.stringify( a ) : String( a ) ).join( ' ' );
	appendFileSync( LOG_FILE, new Date().toISOString().slice( 11, 23 ) + ' ' + msg + '\n' );

}

const TERMINAL_RESET_SEQUENCE = '\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?2031l\x1b[?2027l\x1b[?1049l\x1b[0m\x1b[?25h';
let terminalResetDone = false;

function emergencyTerminalReset( reason = '' ) {

	if ( terminalResetDone ) return;
	terminalResetDone = true;

	if ( reason ) log( 'Emergency terminal reset:', reason );

	try {

		if ( process.stdout && process.stdout.writable )
			process.stdout.write( TERMINAL_RESET_SEQUENCE );

	} catch ( e ) { /* ignore terminal reset failures */ }

}

function installTerminalSafetyHandlers() {

	const onStreamError = ( err ) => {

		if ( err == null ) return;
		if ( err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED' ) {

			emergencyTerminalReset( err.code );
			setImmediate( () => process.exit( 0 ) );
			return;

		}

		log( 'Stream error:', err.message || String( err ) );

	};

	process.stdout.on( 'error', onStreamError );
	process.stderr.on( 'error', onStreamError );
	process.on( 'exit', () => emergencyTerminalReset( 'process-exit' ) );
	const onTerminateSignal = ( signal ) => {

		emergencyTerminalReset( signal.toLowerCase() );
		setImmediate( () => process.exit( 0 ) );

	};
	process.on( 'SIGTERM', () => onTerminateSignal( 'SIGTERM' ) );
	process.on( 'SIGHUP', () => onTerminateSignal( 'SIGHUP' ) );
	process.on( 'SIGQUIT', () => onTerminateSignal( 'SIGQUIT' ) );

}

installTerminalSafetyHandlers();

function installConsoleNoiseFilters() {

	const originalWarn = console.warn.bind( console );
	const originalError = console.error.bind( console );
	let uvWarningSuppressed = 0;
	let epipeSuppressed = 0;

	console.warn = ( ...args ) => {

		const msg = args.map( a => String( a ) ).join( ' ' );
		if ( msg.includes( 'AttributeNode: Vertex attribute "uv" not found on geometry.' ) ) {

			_uvSanitizeRequested = true;
			uvWarningSuppressed ++;
			if ( uvWarningSuppressed === 1 )
				log( 'Suppressing repeated Three.js uv warnings' );
			return;

		}

		originalWarn( ...args );

	};

	console.error = ( ...args ) => {

		const msg = args.map( a => String( a ) ).join( ' ' );
		if ( msg.includes( 'EPIPE: broken pipe, send' ) ) {

			epipeSuppressed ++;
			if ( epipeSuppressed === 1 )
				log( 'Suppressing repeated EPIPE console errors' );
			return;

		}

		originalError( ...args );

	};

}

installConsoleNoiseFilters();

async function precompileCurrentMapScene( threeCliRenderer, rootScene, activeCamera, options = {} ) {

	if ( !threeCliRenderer || !rootScene || !activeCamera ) return false;

	const renderer = threeCliRenderer.threeRenderer;
	if ( !renderer || typeof renderer.compileAsync !== 'function' ) {

		log( 'Precompile skipped: Three.js compileAsync unavailable' );
		return false;

	}

	const precompileTextures = options.precompileTextures !== false;
	const forceVisible = options.forceVisible === true;
	const warmRender = options.warmRender === true;
	const passId = ++ _precompilePassSerial;
	const t0 = performance.now();

	const renderables = [];
	const allObjects = [];
	const frustumStates = [];
	const visibleStates = [];
	const materials = new Set();
	const textures = new Set();

	rootScene.traverse( ( obj ) => {

		allObjects.push( obj );
		if ( forceVisible ) {

			visibleStates.push( [ obj, obj.visible ] );
			obj.visible = true;

		}

		if ( obj.isMesh || obj.isSprite || obj.isPoints || obj.isLine ) {

			renderables.push( obj );
			frustumStates.push( [ obj, obj.frustumCulled ] );
			obj.frustumCulled = false;

			const material = obj.material;
			if ( Array.isArray( material ) ) {

				for ( const m of material ) if ( m ) materials.add( m );

			} else if ( material ) {

				materials.add( material );

			}

		}

	} );

	const collectTexture = ( tex ) => {

		if ( tex && tex.isTexture ) textures.add( tex );

	};

	for ( const material of materials ) {

		for ( const key of Object.keys( material ) ) {

			collectTexture( material[ key ] );

		}

	}

	let textureMs = 0;
	let compileMs = 0;
	let warmRenderMs = 0;
	let textureCount = 0;
	let materialCount = materials.size;

	try {

		if ( precompileTextures && typeof renderer.initTextureAsync === 'function' && textures.size > 0 ) {

			const textureStart = performance.now();
			for ( const texture of textures ) {

				try {

					await renderer.initTextureAsync( texture );
					textureCount ++;

				} catch ( e ) {

					log( 'Precompile texture init failed:', e.message || String( e ) );

				}

			}
			textureMs = performance.now() - textureStart;

		}

		const compileStart = performance.now();
		await renderer.compileAsync( rootScene, activeCamera );
		compileMs = performance.now() - compileStart;

		if ( warmRender ) {

			// Optional: force remaining lazy setup outside gameplay.
			const warmRenderStart = performance.now();
			await renderer.render( rootScene, activeCamera );
			warmRenderMs = performance.now() - warmRenderStart;

		}

		log(
			'Precompile',
			`pass=${passId}`,
			'ok',
			`renderables=${renderables.length}`,
			`objects=${allObjects.length}`,
			`materials=${materialCount}`,
			`textures=${textureCount}/${textures.size}`,
			`texturesMs=${textureMs.toFixed( 1 )}ms`,
			`compileMs=${compileMs.toFixed( 1 )}ms`,
			`warmRenderMs=${warmRenderMs.toFixed( 1 )}ms`,
			`total=${( performance.now() - t0 ).toFixed( 1 )}ms`,
			`forceVisible=${forceVisible ? 1 : 0}`,
			`warmRender=${warmRender ? 1 : 0}`
		);
		return true;

	} catch ( e ) {

		log(
			'Precompile',
			`pass=${passId}`,
			'FAILED',
			e.message || String( e ),
			e.stack || ''
		);
		return false;

	} finally {

		for ( const [ obj, original ] of frustumStates ) obj.frustumCulled = original;
		if ( forceVisible ) {

			for ( const [ obj, original ] of visibleStates ) obj.visible = original;

		}

	}

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
import { M_TouchInput } from './src/menu.js';
import { VID_TuiResize, renderer as vidRenderer } from './src/vid.js';

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
			emergencyTerminalReset( 'missing-pak0' );
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

		const disableDynamicLights = process.env.QUAKE_TUI_DYNAMIC_LIGHTS !== '1';
		const disableFlashBlend = process.env.QUAKE_TUI_FLASHBLEND !== '1';
		if ( disableDynamicLights ) Cbuf_AddText( 'r_dynamic 0\n' );
		if ( disableFlashBlend ) Cbuf_AddText( 'gl_flashblend 0\n' );
		if ( disableDynamicLights || disableFlashBlend ) {

			log(
				'TUI perf defaults:',
				`r_dynamic=${disableDynamicLights ? 0 : 1}`,
				`gl_flashblend=${disableFlashBlend ? 0 : 1}`
			);

		}

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

			const ambientRaw = Number.parseFloat( process.env.QUAKE_TUI_AMBIENT_LIGHT || '2.6' );
			const directionalRaw = Number.parseFloat( process.env.QUAKE_TUI_DIRECTIONAL_LIGHT || '0.95' );
			const ambientIntensity = Number.isFinite( ambientRaw ) ? ambientRaw : 2.6;
			const directionalIntensity = Number.isFinite( directionalRaw ) ? directionalRaw : 0.95;

			scene.add( new THREE.AmbientLight( 0xffffff, ambientIntensity ) );
			const fillLight = new THREE.DirectionalLight( 0xffffff, directionalIntensity );
			fillLight.position.set( 0.25, 1, 0.5 );
			scene.add( fillLight );

		}

		// ----------------------------------------------------------------
		// Initialize OpenTUI
		// ----------------------------------------------------------------

		log( 'Creating CliRenderer...' );
		const targetFpsRaw = Number.parseInt( process.env.QUAKE_TUI_TARGET_FPS || '30', 10 );
		const targetFps = Number.isFinite( targetFpsRaw ) && targetFpsRaw > 0 ? targetFpsRaw : 30;
		const cliRenderer = await createCliRenderer( {
			targetFps,
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

			const minRenderWidthRaw = Number.parseInt( process.env.QUAKE_TUI_MIN_RENDER_WIDTH || '320', 10 );
			const minRenderHeightRaw = Number.parseInt( process.env.QUAKE_TUI_MIN_RENDER_HEIGHT || '240', 10 );
			const maxRenderWidthRaw = Number.parseInt( process.env.QUAKE_TUI_MAX_RENDER_WIDTH || '1024', 10 );
			const maxRenderHeightRaw = Number.parseInt( process.env.QUAKE_TUI_MAX_RENDER_HEIGHT || '768', 10 );
		const renderScaleRaw = Number.parseFloat( process.env.QUAKE_TUI_RENDER_SCALE || '1' );

			const minRenderWidth = Number.isFinite( minRenderWidthRaw ) && minRenderWidthRaw > 0 ? minRenderWidthRaw : 320;
			const minRenderHeight = Number.isFinite( minRenderHeightRaw ) && minRenderHeightRaw > 0 ? minRenderHeightRaw : 240;
			const maxRenderWidthCandidate = Number.isFinite( maxRenderWidthRaw ) && maxRenderWidthRaw > 0 ? maxRenderWidthRaw : 1024;
			const maxRenderHeightCandidate = Number.isFinite( maxRenderHeightRaw ) && maxRenderHeightRaw > 0 ? maxRenderHeightRaw : 768;
		const maxRenderWidth = Math.max( minRenderWidth, maxRenderWidthCandidate );
		const maxRenderHeight = Math.max( minRenderHeight, maxRenderHeightCandidate );
		const renderScale = Number.isFinite( renderScaleRaw ) && renderScaleRaw > 0 ? renderScaleRaw : 1;

		const minRenderCellsW = Math.max( 1, Math.floor( minRenderWidth / 2 ) );
		const minRenderCellsH = Math.max( 1, Math.floor( minRenderHeight / 2 ) );
		const maxRenderCellsW = Math.max( minRenderCellsW, Math.floor( maxRenderWidth / 2 ) );
		const maxRenderCellsH = Math.max( minRenderCellsH, Math.floor( maxRenderHeight / 2 ) );

			const computeRenderSize = ( termW, termH ) => {

				const scaledW = Math.max( 1, Math.floor( termW * renderScale ) );
				const scaledH = Math.max( 1, Math.floor( termH * renderScale ) );
				const renderW = clampInt( scaledW, minRenderCellsW, maxRenderCellsW );
				const renderH = clampInt( scaledH, minRenderCellsH, maxRenderCellsH );
				return { renderW, renderH };

		};

		const syncQuakeVideoSize = ( cellW, cellH ) => {

			// Terminal cell buffer is treated as a 2x supersampled Quake pixel grid.
			const targetW = Math.max( 1, cellW * 2 );
			const targetH = Math.max( 1, cellH * 2 );
			VID_TuiResize( targetW, targetH );
			log( 'Quake vid resize:', targetW + 'x' + targetH );

		};

		let { renderW, renderH } = computeRenderSize( cliRenderer.width, cliRenderer.height );

		log(
			'Terminal:', cliRenderer.width, 'x', cliRenderer.height,
			'=> render:', renderW, 'x', renderH,
			'(min px:', minRenderWidth + 'x' + minRenderHeight +
			', max px:', maxRenderWidth + 'x' + maxRenderHeight +
			', cell range:', minRenderCellsW + 'x' + minRenderCellsH + '..' + maxRenderCellsW + 'x' + maxRenderCellsH +
			', scale:', renderScale.toFixed( 2 ) +
			', fps:', targetFps + ')'
		);

		log( 'Creating ThreeCliRenderer...' );
		const superSampleModeEnv = String( process.env.QUAKE_TUI_SUPERSAMPLE || 'none' ).toLowerCase();
		const superSampleMode = superSampleModeEnv === 'gpu' || superSampleModeEnv === 'cpu' || superSampleModeEnv === 'none'
			? superSampleModeEnv
			: 'none';
		const threeRenderer = new ThreeCliRenderer( cliRenderer, {
			width: renderW,
			height: renderH,
			backgroundColor: { r: 0, g: 0, b: 0, a: 255 },
			superSample: superSampleMode,
			autoResize: false
		} );

		await threeRenderer.init();
		log( 'ThreeCliRenderer initialized' );
		log( 'ThreeCliRenderer ready' );
		syncQuakeVideoSize( renderW, renderH );

		const precompileEnabled = process.env.QUAKE_TUI_PRECOMPILE !== '0';
		const precompileTextures = process.env.QUAKE_TUI_PRECOMPILE_TEXTURES !== '0';
		const precompileForceVisible = process.env.QUAKE_TUI_PRECOMPILE_FORCE_VISIBLE === '1';
		const precompileWarmRender = process.env.QUAKE_TUI_PRECOMPILE_WARM_RENDER === '1';
		let precompiledSceneRef = null;
		let precompiledSceneChildren = -1;
		let precompileInFlight = null;
		let precompilePendingReason = '';

		const queueScenePrecompile = ( reason ) => {

			if ( !precompileEnabled ) return;
			if ( !scene || !camera ) return;
			precompilePendingReason = reason || 'unspecified';
			if ( precompileInFlight ) return;

			precompileInFlight = ( async () => {

				const sceneToCompile = scene;
				const cameraToCompile = camera;
				const reasonText = precompilePendingReason;
				const sceneChildrenBefore = sceneToCompile ? sceneToCompile.children.length : 0;

				try {

					log(
						'Precompile queue:',
						reasonText,
						`sceneChildren=${sceneChildrenBefore}`
					);
					const compiled = await precompileCurrentMapScene(
						threeRenderer,
						sceneToCompile,
						cameraToCompile,
						{
							precompileTextures,
							forceVisible: precompileForceVisible,
							warmRender: precompileWarmRender && ( reasonText === 'startup' || reasonText === 'scene-changed' )
						}
					);
					if ( compiled ) {

						precompiledSceneRef = sceneToCompile;
						precompiledSceneChildren = sceneToCompile ? sceneToCompile.children.length : -1;

					}

				} finally {

					precompileInFlight = null;

				}

			} )();

			return precompileInFlight;

		};

		await queueScenePrecompile( 'startup' );

		// Render scene into an offscreen buffer, then scale-composite in post-process
		// so root renderables cannot overwrite the 3D frame.
		const sceneBuffer = OptimizedBuffer.create(
			renderW,
			renderH,
			cliRenderer.nextRenderBuffer.widthMethod,
			{ id: 'quake-scene-buffer' }
		);
		let sceneBufferReady = false;

		const onRendererResize = ( termW, termH ) => {

			const next = computeRenderSize( termW, termH );
			if ( next.renderW === renderW && next.renderH === renderH ) return;

			renderW = next.renderW;
			renderH = next.renderH;
			threeRenderer.setSize( renderW, renderH, true );
			sceneBuffer.resize( renderW, renderH );
			sceneBufferReady = false;
			syncQuakeVideoSize( renderW, renderH );

			log(
				'Terminal resize:',
				termW + 'x' + termH,
				'=> render:',
				renderW + 'x' + renderH
			);

		};

		cliRenderer.on( 'resize', onRendererResize );
		cliRenderer.on( 'destroy', () => {

			cliRenderer.off( 'resize', onRendererResize );
			sceneBuffer.destroy();

		} );

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
		const simTickHzRaw = Number.parseInt( process.env.QUAKE_TUI_SIM_TICK_HZ || '60', 10 );
		const simTickHz = Number.isFinite( simTickHzRaw ) && simTickHzRaw > 0 ? simTickHzRaw : 60;
		const simTickDt = 1 / simTickHz;
		const maxSimStepsRaw = Number.parseInt( process.env.QUAKE_TUI_SIM_MAX_STEPS || '30', 10 );
		const maxSimSteps = Number.isFinite( maxSimStepsRaw ) && maxSimStepsRaw > 0 ? maxSimStepsRaw : 30;
		const simFrameDtCapMsRaw = Number.parseFloat( process.env.QUAKE_TUI_SIM_FRAME_DT_CAP_MS || '500' );
		const simFrameDtCapMs = Number.isFinite( simFrameDtCapMsRaw ) && simFrameDtCapMsRaw > 0
			? simFrameDtCapMsRaw
			: 500;
		const simFrameDtCap = simFrameDtCapMs / 1000;
		log( 'Sim loop config:', `tick=${simTickHz}Hz`, `maxSteps=${maxSimSteps}`, `dtCapMs=${simFrameDtCapMs.toFixed( 0 )}` );
		let simAccumulator = 0;
		let frameCount = 0;
		let lastPostProcessMs = 0;
		let renderJob = null;
		let renderJobStartedAtMs = 0;
		let renderJobStartFrame = 0;
		let renderSkipCount = 0;
		let lastCompletedRenderStats = {
			frame: 0,
			drawSceneMs: 0,
			otRenderMs: 0,
			otReadbackMs: 0,
			otMapAsyncMs: 0,
			otSsDrawMs: 0,
			exposureMs: 0,
			overlayMs: 0
		};

		const startAsyncRenderJob = ( deltaTime ) => {

			if ( renderJob || !scene || !camera ) return false;
			const renderSceneRef = scene;
			const renderCameraRef = camera;
			renderJobStartedAtMs = performance.now();
			renderJobStartFrame = frameCount;
			const job = ( async () => {

				let drawSceneMs = 0;
				let otRenderMs = 0;
				let otReadbackMs = 0;
				let otMapAsyncMs = 0;
				let otSsDrawMs = 0;
				let exposureMs = 0;
				let overlayMs = 0;

				threeRenderer.setActiveCamera( renderCameraRef );
				if ( perfDebug ) {

					const t0 = performance.now();
					await threeRenderer.drawScene( renderSceneRef, sceneBuffer, deltaTime );
					drawSceneMs = performance.now() - t0;
					otRenderMs = Number.isFinite( threeRenderer.renderTimeMs ) ? threeRenderer.renderTimeMs : 0;
					otReadbackMs = Number.isFinite( threeRenderer.readbackTimeMs ) ? threeRenderer.readbackTimeMs : 0;
					otMapAsyncMs = Number.isFinite( threeRenderer.canvas?.mapAsyncTimeMs ) ? threeRenderer.canvas.mapAsyncTimeMs : 0;
					otSsDrawMs = Number.isFinite( threeRenderer.canvas?.superSampleDrawTimeMs ) ? threeRenderer.canvas.superSampleDrawTimeMs : 0;

				} else {

					await threeRenderer.drawScene( renderSceneRef, sceneBuffer, deltaTime );

				}

				const exposure = getTuiExposureParams();
				if ( perfDebug ) {

					const t0 = performance.now();
					boostBufferExposure( sceneBuffer, exposure.gain, exposure.gamma );
					exposureMs = performance.now() - t0;

				} else {

					boostBufferExposure( sceneBuffer, exposure.gain, exposure.gamma );

				}
				if ( perfDebug ) {

					const t0 = performance.now();
					compositeOverlayIntoBuffer( sceneBuffer );
					overlayMs = performance.now() - t0;

				} else {

					compositeOverlayIntoBuffer( sceneBuffer );

				}

				sceneBufferReady = true;
				lastCompletedRenderStats = {
					frame: frameCount,
					drawSceneMs,
					otRenderMs,
					otReadbackMs,
					otMapAsyncMs,
					otSsDrawMs,
					exposureMs,
					overlayMs
				};

				if ( typeof cliRenderer.requestRender === 'function' ) {

					cliRenderer.requestRender();

				}

				if ( perfDebug && ( drawSceneMs >= perfSpikeThresholdMs || otRenderMs >= perfSpikeThresholdMs ) ) {

					log(
						'RenderJob',
						`startedFrame=${renderJobStartFrame}`,
						`completedAtFrame=${frameCount}`,
						`queuedFor=${( performance.now() - renderJobStartedAtMs ).toFixed( 1 )}ms`,
						`draw=${drawSceneMs.toFixed( 1 )}ms`,
						`otRender=${otRenderMs.toFixed( 1 )}ms`,
						`otReadback=${otReadbackMs.toFixed( 1 )}ms`,
						`otMapAsync=${otMapAsyncMs.toFixed( 1 )}ms`
					);

				}

			} )().catch( ( e ) => {

				log( 'Async render job failed:', e.message || String( e ), e.stack || '' );

			} ).finally( () => {

				if ( renderJob === job ) renderJob = null;

			} );

			renderJob = job;
			return true;

		};

		cliRenderer.setFrameCallback( async ( deltaTime ) => {

			const perfFrameStart = perfDebug ? performance.now() : 0;
			let hostFrameMs = 0;
			let uvSanitizeMs = 0;
			let drawSceneMs = lastCompletedRenderStats.drawSceneMs;
			let otRenderMs = lastCompletedRenderStats.otRenderMs;
			let otReadbackMs = lastCompletedRenderStats.otReadbackMs;
			let otMapAsyncMs = lastCompletedRenderStats.otMapAsyncMs;
			let otSsDrawMs = lastCompletedRenderStats.otSsDrawMs;
			let exposureMs = lastCompletedRenderStats.exposureMs;
			let overlayMs = lastCompletedRenderStats.overlayMs;
			const now = performance.now() / 1000;
				const dt = Math.min( now - lastTime, simFrameDtCap );
				lastTime = now;
				frameCount ++;

				// Update Quake engine (game logic, physics, scene graph) at a fixed
				// simulation tick rate so render stalls do not directly change sim dt.
				simAccumulator = Math.min( simAccumulator + dt, simTickDt * maxSimSteps );
				let simSteps = 0;
				if ( perfDebug ) {

					const t0 = performance.now();
					while ( simAccumulator >= simTickDt && simSteps < maxSimSteps ) {

						Host_Frame( simTickDt );
						simAccumulator -= simTickDt;
						simSteps ++;

					}
					hostFrameMs = performance.now() - t0;

				} else {

					while ( simAccumulator >= simTickDt && simSteps < maxSimSteps ) {

						Host_Frame( simTickDt );
						simAccumulator -= simTickDt;
						simSteps ++;

					}

				}

			uvSanitizeMs = maybeEnsureSceneTextureUVs( scene, frameCount );

			if ( precompileEnabled && scene && camera ) {

				if ( precompiledSceneRef !== scene ) {

					queueScenePrecompile( 'scene-changed' );

				} else if ( scene.children.length > precompiledSceneChildren ) {

					queueScenePrecompile( 'scene-grew' );

				}

			}

			// Launch render asynchronously so sim/input keep updating during GPU stalls.
			if ( !precompileInFlight ) {

				if ( !startAsyncRenderJob( deltaTime ) ) renderSkipCount ++;

			}

			if ( perfDebug ) {

				const frameMs = performance.now() - perfFrameStart;
				const renderBusyMs = renderJob ? performance.now() - renderJobStartedAtMs : 0;
				if (
					frameCount <= 5 ||
					frameMs >= perfSpikeThresholdMs ||
					hostFrameMs >= perfSpikeThresholdMs ||
					renderBusyMs >= perfSpikeThresholdMs
				) {

					log(
						'Perf',
						`frame=${frameCount}`,
						`total=${frameMs.toFixed( 1 )}ms`,
							`host=${hostFrameMs.toFixed( 1 )}ms`,
							`simSteps=${simSteps}`,
							`uvscan=${uvSanitizeMs.toFixed( 1 )}ms`,
						`draw=${drawSceneMs.toFixed( 1 )}ms`,
						`otRender=${otRenderMs.toFixed( 1 )}ms`,
						`otReadback=${otReadbackMs.toFixed( 1 )}ms`,
						`otMapAsync=${otMapAsyncMs.toFixed( 1 )}ms`,
						`otSS=${otSsDrawMs.toFixed( 1 )}ms`,
						`exposure=${exposureMs.toFixed( 1 )}ms`,
						`overlay=${overlayMs.toFixed( 1 )}ms`,
						`renderBusy=${renderJob ? 1 : 0}`,
						`renderBusyMs=${renderBusyMs.toFixed( 1 )}ms`,
						`renderSkips=${renderSkipCount}`,
						`blit=${lastPostProcessMs.toFixed( 1 )}ms`,
						`render=${renderW}x${renderH}`,
						`sceneChildren=${scene ? scene.children.length : 0}`
					);

				}

			}

			if ( frameCount <= 3 || frameCount % 300 === 0 ) {

				log(
					'Frame',
					frameCount,
					'scene:',
					scene ? scene.children.length + ' children' : 'null',
					'camera:',
					camera ? 'pos=' + camera.position.x.toFixed( 0 ) + ',' + camera.position.y.toFixed( 0 ) + ',' + camera.position.z.toFixed( 0 ) : 'null'
				);
				logInputState( 'FrameState' );

			}

		} );

		cliRenderer.addPostProcessFn( ( buffer ) => {

			const t0 = perfDebug ? performance.now() : 0;
			if ( sceneBufferReady ) {

				blitScaledBufferNearest( sceneBuffer, buffer );

			}
			if ( perfDebug ) lastPostProcessMs = performance.now() - t0;

		} );

		log( 'Starting render loop...' );
		cliRenderer.start();

	} catch ( e ) {

		log( 'FATAL ERROR:', e.message, e.stack );
		console.error( 'Three-Quake TUI Fatal Error:', e );
		emergencyTerminalReset( 'main-fatal' );
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
	const fallbackHoldIdleReleaseRaw = Number.parseInt( process.env.QUAKE_TUI_HOLD_IDLE_RELEASE_MS || '340', 10 );
	const fallbackHoldIdleReleaseMs = Number.isFinite( fallbackHoldIdleReleaseRaw ) && fallbackHoldIdleReleaseRaw > 0
		? fallbackHoldIdleReleaseRaw
		: 340;

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
	const pressedHoldKeys = new Set();
	const releaseTimers = new Map();
	let hasKeyReleaseEvents = false;
	let parsedKeyInputActive = false;
	let holdReleaseIdleTimer = null;

	function clearReleaseTimer( key ) {

		const timer = releaseTimers.get( key );
		if ( timer ) {

			clearTimeout( timer );
			releaseTimers.delete( key );

		}

	}

	function hasPressedHoldKeys() {

		return pressedHoldKeys.size > 0;

	}

	function clearHoldReleaseIdleTimer() {

		if ( holdReleaseIdleTimer ) {

			clearTimeout( holdReleaseIdleTimer );
			holdReleaseIdleTimer = null;

		}

	}

	function scheduleHoldReleaseIdleFallback() {

		if ( hasKeyReleaseEvents ) return;
		clearHoldReleaseIdleTimer();
		if ( ! hasPressedHoldKeys() ) return;

		holdReleaseIdleTimer = setTimeout( () => {

			holdReleaseIdleTimer = null;
			if ( hasKeyReleaseEvents ) return;

			// Fallback for terminals without keyup events:
			// release held movement/action keys after keyboard idle.
			for ( const key of Array.from( pressedKeys ) ) {

				if ( isHoldBindingKey( key ) ) releaseKey( key );

			}

		}, fallbackHoldIdleReleaseMs );

	}

	function clearAllReleaseTimers() {

		for ( const timer of releaseTimers.values() ) clearTimeout( timer );
		releaseTimers.clear();
		clearHoldReleaseIdleTimer();
		pressedHoldKeys.clear();

	}

	function releasePressedKeys() {

		for ( const key of Array.from( pressedKeys ) ) releaseKey( key );

	}

	function isHoldBindingKey( key ) {

		const binding = keybindings[ key ];
		return typeof binding === 'string' && binding.startsWith( '+' );

	}

	function shouldForceTapFallback( key ) {

		// Some terminals do not emit reliable keyrelease events for Enter.
		// Treat it as a tap in fallback mode to avoid stuck +attack when bound.
		return key === K_ENTER;

	}

	function scheduleReleaseFallback( key, delayMs ) {

		if ( hasKeyReleaseEvents ) return;

		clearReleaseTimer( key );
		const timer = setTimeout( () => {

			releaseTimers.delete( key );
			releaseKey( key );

		}, delayMs );
		releaseTimers.set( key, timer );

	}

	function releaseKey( key ) {

		clearReleaseTimer( key );
		if ( pressedKeys.has( key ) ) {

			pressedHoldKeys.delete( key );
			pressedKeys.delete( key );
			if ( inputDebug ) log( 'Key up:', key );
			Key_Event( key, false );

		}

		if ( ! hasKeyReleaseEvents ) scheduleHoldReleaseIdleFallback();

	}

	function pressKey( key ) {

		let holdBinding = pressedHoldKeys.has( key );
		if ( ! pressedKeys.has( key ) ) {

			pressedKeys.add( key );
			holdBinding = isHoldBindingKey( key );
			if ( holdBinding ) pressedHoldKeys.add( key );
			if ( inputDebug ) log( 'Key down:', key );
			Key_Event( key, true );

		}

		// Fallback for terminals that do not emit keyrelease events.
		const forceTapFallback = shouldForceTapFallback( key );
		if ( forceTapFallback ) {

			pressedHoldKeys.delete( key );
			holdBinding = false;

		}

		if ( ! hasKeyReleaseEvents || forceTapFallback ) {

			if ( holdBinding ) {

				scheduleHoldReleaseIdleFallback();

			} else {

				const tapDelayMs = forceTapFallback ? Math.max( fallbackTapReleaseMs, 45 ) : fallbackTapReleaseMs;
				scheduleReleaseFallback( key, tapDelayMs );

			}

		}

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
		try {

			cliRenderer.destroy();

		} catch ( e ) {

			log( 'Destroy error during Ctrl+C:', e && e.message ? e.message : String( e ) );

		}
		emergencyTerminalReset( 'ctrl-c' );
		process.exit( 0 );

	}

	function handleRawSequence( sequence ) {

		if ( typeof sequence !== 'string' || sequence.length === 0 ) return false;

		if ( sequence === '\x03' ) {

			handleCtrlC();
			return true;

		}

		// Parsed OpenTUI key events are lower overhead and include keyrelease.
		// Once we know they work, disable the raw-sequence fallback path.
		if ( parsedKeyInputActive ) return false;

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

		if ( ! parsedKeyInputActive ) {

			parsedKeyInputActive = true;
			cliRenderer.removeInputHandler( handleRawSequence );
			if ( inputDebug ) log( 'Parsed key input active; raw fallback handler removed' );

		}

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

		if ( ! parsedKeyInputActive ) {

			parsedKeyInputActive = true;
			cliRenderer.removeInputHandler( handleRawSequence );
			if ( inputDebug ) log( 'Parsed key input active; raw fallback handler removed' );

		}

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
			parsedKeyInputActive = false;

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

	function handleMenuClick( event ) {

		const screenWidth = Math.max( 1, cliRenderer.width | 0 );
		const screenHeight = Math.max( 1, cliRenderer.height | 0 );
		const eventX = Number.isFinite( event.x ) ? event.x : 0;
		const eventY = Number.isFinite( event.y ) ? event.y : 0;
		const x = clampInt( eventX | 0, 0, screenWidth - 1 );
		const y = clampInt( eventY | 0, 0, screenHeight - 1 );
		M_TouchInput( x, y, screenWidth, screenHeight );

		if ( inputDebug )
			log( 'Menu click:', x + ',' + y, 'screen=' + screenWidth + 'x' + screenHeight );

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

					if ( key_dest === key_menu ) {

						releaseMouseKey( K_MOUSE1 );
						releaseMouseKey( K_MOUSE2 );
						releaseMouseKey( K_MOUSE3 );

					} else {

						setMouseKeyState( K_MOUSE1, ( b0 & 0x01 ) !== 0 );
						setMouseKeyState( K_MOUSE2, ( b0 & 0x02 ) !== 0 );
						setMouseKeyState( K_MOUSE3, ( b0 & 0x04 ) !== 0 );

					}

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

		if ( event.button === 0 && key_dest === key_menu ) {

			handleMenuClick( event );
			event.preventDefault();
			return;

		}

		if ( event.button === 0 && key_dest === key_game && cls.demoplayback ) {

			M_TouchInput( 0, 0, 1, 1 );
			event.preventDefault();
			return;

		}

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

const _uvSanitizedGeometries = new WeakSet();
const _uvSanitizeFailedGeometries = new WeakSet();
let _uvPatchedCount = 0;
let _uvLastRootChildCount = - 1;

function maybeEnsureSceneTextureUVs( root, frameCount ) {

	if ( ! root ) return 0;

	const rootChildCount = Array.isArray( root.children ) ? root.children.length : - 1;
	const startupScan = frameCount <= 180 && ( frameCount <= 30 || frameCount % 15 === 0 );
	const periodicScan = frameCount % 240 === 0;
	const sceneTopologyChanged = rootChildCount !== _uvLastRootChildCount;
	const shouldScan = _uvSanitizeRequested || startupScan || periodicScan || sceneTopologyChanged;

	if ( ! shouldScan ) return 0;

	const t0 = perfDebug ? performance.now() : 0;
	ensureSceneTextureUVs( root );
	_uvSanitizeRequested = false;
	_uvLastRootChildCount = rootChildCount;

	return perfDebug ? performance.now() - t0 : 0;

}

function ensureSceneTextureUVs( root ) {

	if ( ! root || typeof root.traverse !== 'function' ) return;

	root.traverse( ( object3d ) => {

		const geometry = object3d && object3d.geometry;
		if ( ! geometry || _uvSanitizedGeometries.has( geometry ) || _uvSanitizeFailedGeometries.has( geometry ) ) return;

		try {

			const position = geometry.getAttribute ? geometry.getAttribute( 'position' ) : null;
			const vertexCount = position && Number.isFinite( position.count ) ? position.count : 0;
			if ( vertexCount <= 0 ) {

				_uvSanitizedGeometries.add( geometry );
				return;

			}

			let patched = false;
			let uvAttr = geometry.getAttribute( 'uv' );

			if ( uvAttr == null ) {

				uvAttr = new THREE.Float32BufferAttribute( vertexCount * 2, 2 );
				geometry.setAttribute( 'uv', uvAttr );
				patched = true;

			}

			if ( geometry.getAttribute( 'uv1' ) == null ) {

				geometry.setAttribute( 'uv1', uvAttr );
				patched = true;

			}

			if ( patched ) {

				_uvPatchedCount ++;
				if ( runtimeDebug || _uvPatchedCount <= 5 ) {

					log(
						'Patched missing uv attributes:',
						object3d.type || 'Object3D',
						object3d.name || '(unnamed)',
						'verts=' + vertexCount
					);

				} else if ( _uvPatchedCount === 6 ) {

					log( 'Patched missing uv attributes: (additional logs suppressed)' );

				}

			}

			_uvSanitizedGeometries.add( geometry );

		} catch ( error ) {

			_uvSanitizeFailedGeometries.add( geometry );
			log(
				'Failed to patch uv attributes:',
				object3d && object3d.type ? object3d.type : 'Object3D',
				error && error.message ? error.message : String( error )
			);

		}

	} );

}

function clampInt( value, min, max ) {

	if ( value < min ) return min;
	if ( value > max ) return max;
	return value | 0;

}

function getTuiExposureParams() {

	const rawExposure = vidRenderer && Number.isFinite( vidRenderer.toneMappingExposure )
		? vidRenderer.toneMappingExposure
		: 1.5;

	// Brightness boost requested: double the TUI output gain while keeping the
	// in-game gamma slider as the source of truth (via toneMappingExposure).
	const gain = Math.max( 0.55, Math.min( 4.0, rawExposure * ( 2.0 / 1.5 ) ) );
	const gamma = gain > 2.8 ? 0.90 : gain > 1.9 ? 0.95 : 1.0;
	return { gain, gamma };

}

function blitScaledBufferNearest( srcBuffer, dstBuffer ) {

	const srcW = srcBuffer.width;
	const srcH = srcBuffer.height;
	const dstW = dstBuffer.width;
	const dstH = dstBuffer.height;

	if ( srcW === dstW && srcH === dstH ) {

		dstBuffer.drawFrameBuffer( 0, 0, srcBuffer );
		return;

	}

	const srcChars = srcBuffer.buffers.char;
	const srcFg = srcBuffer.buffers.fg;
	const srcBg = srcBuffer.buffers.bg;
	const srcAttrs = srcBuffer.buffers.attributes;
	const dstChars = dstBuffer.buffers.char;
	const dstFg = dstBuffer.buffers.fg;
	const dstBg = dstBuffer.buffers.bg;
	const dstAttrs = dstBuffer.buffers.attributes;
 
	for ( let y = 0; y < dstH; y ++ ) {

		const sy = Math.min( srcH - 1, Math.floor( y * srcH / dstH ) );
		const srcRow = sy * srcW;
		const dstRow = y * dstW;

		for ( let x = 0; x < dstW; x ++ ) {

			const sx = Math.min( srcW - 1, Math.floor( x * srcW / dstW ) );
			const srcCellIdx = srcRow + sx;
			const dstCellIdx = dstRow + x;
			const srcColorIdx = srcCellIdx * 4;
			const dstColorIdx = dstCellIdx * 4;

			dstChars[ dstCellIdx ] = srcChars[ srcCellIdx ];
			dstAttrs[ dstCellIdx ] = srcAttrs[ srcCellIdx ];

			dstFg[ dstColorIdx ] = srcFg[ srcColorIdx ];
			dstFg[ dstColorIdx + 1 ] = srcFg[ srcColorIdx + 1 ];
			dstFg[ dstColorIdx + 2 ] = srcFg[ srcColorIdx + 2 ];
			dstFg[ dstColorIdx + 3 ] = srcFg[ srcColorIdx + 3 ];

			dstBg[ dstColorIdx ] = srcBg[ srcColorIdx ];
			dstBg[ dstColorIdx + 1 ] = srcBg[ srcColorIdx + 1 ];
			dstBg[ dstColorIdx + 2 ] = srcBg[ srcColorIdx + 2 ];
			dstBg[ dstColorIdx + 3 ] = srcBg[ srcColorIdx + 3 ];

		}

	}

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

const EXPOSURE_LUT_SIZE = 1024;
let _exposureLut = null;
let _exposureLutGain = NaN;
let _exposureLutGamma = NaN;

function getExposureLut( gain, gamma ) {

	const quantizedGain = Math.round( gain * 1000 ) / 1000;
	const quantizedGamma = Math.round( gamma * 1000 ) / 1000;
	if (
		_exposureLut != null &&
		quantizedGain === _exposureLutGain &&
		quantizedGamma === _exposureLutGamma
	) {

		return _exposureLut;

	}

	const lut = new Float32Array( EXPOSURE_LUT_SIZE );
	const maxIndex = EXPOSURE_LUT_SIZE - 1;
	for ( let i = 0; i <= maxIndex; i ++ ) {

		const value = i / maxIndex;
		lut[ i ] = Math.min( 1, Math.pow( Math.max( 0, value * gain ), gamma ) );

	}

	_exposureLut = lut;
	_exposureLutGain = quantizedGain;
	_exposureLutGamma = quantizedGamma;
	return lut;

}

function boostBufferExposure( buffer, gain = 1.0, gamma = 1.0 ) {

	if ( Math.abs( gain - 1 ) < 0.0001 && Math.abs( gamma - 1 ) < 0.0001 ) return;

	const fg = buffer.buffers.fg;
	const bg = buffer.buffers.bg;
	const lut = getExposureLut( gain, gamma );
	const maxIndex = EXPOSURE_LUT_SIZE - 1;

	for ( let i = 0; i < fg.length; i += 4 ) {

		const fgR = Math.min( maxIndex, Math.max( 0, ( fg[ i ] * maxIndex ) | 0 ) );
		const fgG = Math.min( maxIndex, Math.max( 0, ( fg[ i + 1 ] * maxIndex ) | 0 ) );
		const fgB = Math.min( maxIndex, Math.max( 0, ( fg[ i + 2 ] * maxIndex ) | 0 ) );
		fg[ i ] = lut[ fgR ];
		fg[ i + 1 ] = lut[ fgG ];
		fg[ i + 2 ] = lut[ fgB ];

		const bgR = Math.min( maxIndex, Math.max( 0, ( bg[ i ] * maxIndex ) | 0 ) );
		const bgG = Math.min( maxIndex, Math.max( 0, ( bg[ i + 1 ] * maxIndex ) | 0 ) );
		const bgB = Math.min( maxIndex, Math.max( 0, ( bg[ i + 2 ] * maxIndex ) | 0 ) );
		bg[ i ] = lut[ bgR ];
		bg[ i + 1 ] = lut[ bgG ];
		bg[ i + 2 ] = lut[ bgB ];

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
