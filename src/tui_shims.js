// Browser API shims for running Quake in terminal via Bun + OpenTUI
// Must be imported BEFORE any engine modules

import { spawn, spawnSync } from 'node:child_process';
import { Worker as NodeWorker } from 'node:worker_threads';

// Mark TUI mode globally
globalThis.__TUI_MODE = true;

// ============================================================================
// Canvas 2D shim with software pixel buffer.
// Used for Quake menu/HUD/console overlay rendering in TUI mode.
// ============================================================================

function _clampByte( value ) {

	return Math.max( 0, Math.min( 255, value | 0 ) );

}

function _clampUnit( value ) {

	if ( ! Number.isFinite( value ) ) return 0;
	return Math.max( 0, Math.min( 1, value ) );

}

function _parseCssColor( style ) {

	if ( style && typeof style === 'object' && style.__tuiPatternCanvas )
		return style;

	if ( typeof style !== 'string' )
		return { r: 255, g: 255, b: 255, a: 255 };

	const s = style.trim().toLowerCase();

	if ( s.startsWith( '#' ) ) {

		if ( s.length === 4 ) {

			return {
				r: parseInt( s[ 1 ] + s[ 1 ], 16 ),
				g: parseInt( s[ 2 ] + s[ 2 ], 16 ),
				b: parseInt( s[ 3 ] + s[ 3 ], 16 ),
				a: 255
			};

		}

		if ( s.length === 7 ) {

			return {
				r: parseInt( s.slice( 1, 3 ), 16 ),
				g: parseInt( s.slice( 3, 5 ), 16 ),
				b: parseInt( s.slice( 5, 7 ), 16 ),
				a: 255
			};

		}

	}

	const rgbaMatch = s.match( /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+)\s*)?\)$/ );
	if ( rgbaMatch ) {

		const alpha = rgbaMatch[ 4 ] === undefined ? 1 : Number.parseFloat( rgbaMatch[ 4 ] );
		return {
			r: _clampByte( Number.parseFloat( rgbaMatch[ 1 ] ) ),
			g: _clampByte( Number.parseFloat( rgbaMatch[ 2 ] ) ),
			b: _clampByte( Number.parseFloat( rgbaMatch[ 3 ] ) ),
			a: _clampByte( _clampUnit( alpha ) * 255 )
		};

	}

	switch ( s ) {

		case 'black': return { r: 0, g: 0, b: 0, a: 255 };
		case 'white': return { r: 255, g: 255, b: 255, a: 255 };
		default: return { r: 255, g: 255, b: 255, a: 255 };

	}

}

function _blendPixel( dst, idx, srcR, srcG, srcB, srcA ) {

	if ( srcA <= 0 ) return;

	const dstA = dst[ idx + 3 ] / 255;
	const sA = srcA / 255;
	const outA = sA + dstA * ( 1 - sA );
	if ( outA <= 0 ) {

		dst[ idx ] = 0;
		dst[ idx + 1 ] = 0;
		dst[ idx + 2 ] = 0;
		dst[ idx + 3 ] = 0;
		return;

	}

	const dstR = dst[ idx ] / 255;
	const dstG = dst[ idx + 1 ] / 255;
	const dstB = dst[ idx + 2 ] / 255;
	const sR = srcR / 255;
	const sG = srcG / 255;
	const sB = srcB / 255;

	const outR = ( sR * sA + dstR * dstA * ( 1 - sA ) ) / outA;
	const outG = ( sG * sA + dstG * dstA * ( 1 - sA ) ) / outA;
	const outB = ( sB * sA + dstB * dstA * ( 1 - sA ) ) / outA;

	dst[ idx ] = _clampByte( outR * 255 );
	dst[ idx + 1 ] = _clampByte( outG * 255 );
	dst[ idx + 2 ] = _clampByte( outB * 255 );
	dst[ idx + 3 ] = _clampByte( outA * 255 );

}

class CanvasRenderingContext2DShim {

	constructor( canvas ) {

		this.canvas = canvas;
		this.fillStyle = '#000';
		this.strokeStyle = '#000';
		this.globalAlpha = 1;
		this.globalCompositeOperation = 'source-over';
		this.imageSmoothingEnabled = false;
		this.font = '10px sans-serif';
		this.textAlign = 'start';
		this.textBaseline = 'alphabetic';
		this._tx = 0;
		this._ty = 0;
		this._sx = 1;
		this._sy = 1;
		this._stateStack = [];

	}

	_getPixelData() {

		return this.canvas._pixels;

	}

	_toPixelRect( x, y, w, h ) {

		const px = Math.round( x * this._sx + this._tx );
		const py = Math.round( y * this._sy + this._ty );
		const pw = Math.max( 0, Math.round( w * this._sx ) );
		const ph = Math.max( 0, Math.round( h * this._sy ) );
		return { x: px, y: py, w: pw, h: ph };

	}

	_fillRectWithColor( rect, color ) {

		const pixels = this.canvas._pixels;
		const width = this.canvas.width;
		const minX = Math.max( 0, rect.x );
		const minY = Math.max( 0, rect.y );
		const maxX = Math.min( this.canvas.width, rect.x + rect.w );
		const maxY = Math.min( this.canvas.height, rect.y + rect.h );
		const srcA = _clampByte( color.a * _clampUnit( this.globalAlpha ) );

		for ( let y = minY; y < maxY; y ++ ) {

			for ( let x = minX; x < maxX; x ++ ) {

				const idx = ( y * width + x ) * 4;
				_blendPixel( pixels, idx, color.r, color.g, color.b, srcA );

			}

		}

	}

	clearRect( x, y, w, h ) {

		const rect = this._toPixelRect( x, y, w, h );
		const pixels = this.canvas._pixels;
		const width = this.canvas.width;
		const minX = Math.max( 0, rect.x );
		const minY = Math.max( 0, rect.y );
		const maxX = Math.min( this.canvas.width, rect.x + rect.w );
		const maxY = Math.min( this.canvas.height, rect.y + rect.h );

		for ( let py = minY; py < maxY; py ++ ) {

			for ( let px = minX; px < maxX; px ++ ) {

				const idx = ( py * width + px ) * 4;
				pixels[ idx ] = 0;
				pixels[ idx + 1 ] = 0;
				pixels[ idx + 2 ] = 0;
				pixels[ idx + 3 ] = 0;

			}

		}

	}

	fillRect( x, y, w, h ) {

		const rect = this._toPixelRect( x, y, w, h );
		const style = _parseCssColor( this.fillStyle );

		if ( style && style.__tuiPatternCanvas ) {

			const patternCanvas = style.__tuiPatternCanvas;
			const srcPixels = patternCanvas._pixels;
			const srcW = patternCanvas.width;
			const srcH = patternCanvas.height;
			const dstPixels = this.canvas._pixels;
			const dstW = this.canvas.width;
			const minX = Math.max( 0, rect.x );
			const minY = Math.max( 0, rect.y );
			const maxX = Math.min( this.canvas.width, rect.x + rect.w );
			const maxY = Math.min( this.canvas.height, rect.y + rect.h );

			for ( let py = minY; py < maxY; py ++ ) {

				for ( let px = minX; px < maxX; px ++ ) {

					const sx = ( ( px - rect.x ) % srcW + srcW ) % srcW;
					const sy = ( ( py - rect.y ) % srcH + srcH ) % srcH;
					const sIdx = ( sy * srcW + sx ) * 4;
					const dIdx = ( py * dstW + px ) * 4;
					const srcA = _clampByte( srcPixels[ sIdx + 3 ] * _clampUnit( this.globalAlpha ) );
					_blendPixel( dstPixels, dIdx, srcPixels[ sIdx ], srcPixels[ sIdx + 1 ], srcPixels[ sIdx + 2 ], srcA );

				}

			}

			return;

		}

		this._fillRectWithColor( rect, style );

	}

	strokeRect() {}
	fillText() {}
	strokeText() {}
	measureText( text = '' ) { return { width: String( text ).length * 8 }; }

	_resolveSourcePixels( source ) {

		if ( source == null ) return null;
		if ( source instanceof HTMLCanvasElementShim ) {

			return { pixels: source._pixels, width: source.width, height: source.height };

		}

		if ( source.canvas instanceof HTMLCanvasElementShim ) {

			return { pixels: source.canvas._pixels, width: source.canvas.width, height: source.canvas.height };

		}

		if ( source.data && source.width && source.height ) {

			return { pixels: source.data, width: source.width, height: source.height };

		}

		return null;

	}

	drawImage( source, ...args ) {

		const resolved = this._resolveSourcePixels( source );
		if ( ! resolved ) return;

		let sx = 0;
		let sy = 0;
		let sw = resolved.width;
		let sh = resolved.height;
		let dx = 0;
		let dy = 0;
		let dw = resolved.width;
		let dh = resolved.height;

		if ( args.length === 2 ) {

			[ dx, dy ] = args;

		} else if ( args.length === 4 ) {

			[ dx, dy, dw, dh ] = args;

		} else if ( args.length === 8 ) {

			[ sx, sy, sw, sh, dx, dy, dw, dh ] = args;

		} else {

			return;

		}

		if ( sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0 ) return;

		const rect = this._toPixelRect( dx, dy, dw, dh );
		const minX = Math.max( 0, rect.x );
		const minY = Math.max( 0, rect.y );
		const maxX = Math.min( this.canvas.width, rect.x + rect.w );
		const maxY = Math.min( this.canvas.height, rect.y + rect.h );
		const srcPixels = resolved.pixels;
		const srcW = resolved.width;
		const srcH = resolved.height;
		const dstPixels = this.canvas._pixels;
		const dstW = this.canvas.width;

		for ( let py = minY; py < maxY; py ++ ) {

			const v = ( py - rect.y ) / Math.max( 1, rect.h );
			const srcY = Math.max( 0, Math.min( srcH - 1, Math.floor( sy + v * sh ) ) );

			for ( let px = minX; px < maxX; px ++ ) {

				const u = ( px - rect.x ) / Math.max( 1, rect.w );
				const srcX = Math.max( 0, Math.min( srcW - 1, Math.floor( sx + u * sw ) ) );

				const sIdx = ( srcY * srcW + srcX ) * 4;
				const dIdx = ( py * dstW + px ) * 4;
				const srcA = _clampByte( srcPixels[ sIdx + 3 ] * _clampUnit( this.globalAlpha ) );
				_blendPixel( dstPixels, dIdx, srcPixels[ sIdx ], srcPixels[ sIdx + 1 ], srcPixels[ sIdx + 2 ], srcA );

			}

		}

	}

	getImageData( x, y, w, h ) {

		const out = new Uint8ClampedArray( Math.max( 0, w ) * Math.max( 0, h ) * 4 );
		const src = this.canvas._pixels;
		const srcW = this.canvas.width;
		const srcH = this.canvas.height;

		for ( let yy = 0; yy < h; yy ++ ) {

			for ( let xx = 0; xx < w; xx ++ ) {

				const srcX = x + xx;
				const srcY = y + yy;
				if ( srcX < 0 || srcY < 0 || srcX >= srcW || srcY >= srcH ) continue;

				const sIdx = ( srcY * srcW + srcX ) * 4;
				const dIdx = ( yy * w + xx ) * 4;
				out[ dIdx ] = src[ sIdx ];
				out[ dIdx + 1 ] = src[ sIdx + 1 ];
				out[ dIdx + 2 ] = src[ sIdx + 2 ];
				out[ dIdx + 3 ] = src[ sIdx + 3 ];

			}

		}

		return { data: out, width: w, height: h };

	}

	createImageData( w, h ) {

		if ( typeof w === 'object' ) {

			h = w.height;
			w = w.width;

		}

		return { data: new Uint8ClampedArray( Math.max( 0, w ) * Math.max( 0, h ) * 4 ), width: w, height: h };

	}

	putImageData( imageData, x, y ) {

		if ( ! imageData || ! imageData.data ) return;

		const src = imageData.data;
		const srcW = imageData.width;
		const srcH = imageData.height;
		const dst = this.canvas._pixels;
		const dstW = this.canvas.width;
		const dstH = this.canvas.height;

		for ( let yy = 0; yy < srcH; yy ++ ) {

			for ( let xx = 0; xx < srcW; xx ++ ) {

				const dstX = x + xx;
				const dstY = y + yy;
				if ( dstX < 0 || dstY < 0 || dstX >= dstW || dstY >= dstH ) continue;

				const sIdx = ( yy * srcW + xx ) * 4;
				const dIdx = ( dstY * dstW + dstX ) * 4;
				dst[ dIdx ] = src[ sIdx ];
				dst[ dIdx + 1 ] = src[ sIdx + 1 ];
				dst[ dIdx + 2 ] = src[ sIdx + 2 ];
				dst[ dIdx + 3 ] = src[ sIdx + 3 ];

			}

		}

	}

	setTransform( a, b, c, d, e, f ) {

		this._sx = Number.isFinite( a ) ? a : 1;
		this._sy = Number.isFinite( d ) ? d : 1;
		this._tx = Number.isFinite( e ) ? e : 0;
		this._ty = Number.isFinite( f ) ? f : 0;

	}

	resetTransform() {

		this._sx = 1;
		this._sy = 1;
		this._tx = 0;
		this._ty = 0;

	}

	save() {

		this._stateStack.push( {
			fillStyle: this.fillStyle,
			strokeStyle: this.strokeStyle,
			globalAlpha: this.globalAlpha,
			_sx: this._sx,
			_sy: this._sy,
			_tx: this._tx,
			_ty: this._ty
		} );

	}

	restore() {

		const state = this._stateStack.pop();
		if ( ! state ) return;
		this.fillStyle = state.fillStyle;
		this.strokeStyle = state.strokeStyle;
		this.globalAlpha = state.globalAlpha;
		this._sx = state._sx;
		this._sy = state._sy;
		this._tx = state._tx;
		this._ty = state._ty;

	}

	scale( sx, sy ) {

		this._sx *= Number.isFinite( sx ) ? sx : 1;
		this._sy *= Number.isFinite( sy ) ? sy : 1;

	}

	translate( tx, ty ) {

		this._tx += Number.isFinite( tx ) ? tx : 0;
		this._ty += Number.isFinite( ty ) ? ty : 0;

	}

	rotate() {}
	transform() {}
	beginPath() {}
	closePath() {}
	moveTo() {}
	lineTo() {}
	arc() {}
	arcTo() {}
	rect() {}
	fill() {}
	stroke() {}
	clip() {}
	createLinearGradient() { return { addColorStop() {} }; }
	createRadialGradient() { return { addColorStop() {} }; }
	createPattern( canvas, repetition = 'repeat' ) {

		if ( ! canvas ) return null;
		return {
			__tuiPatternCanvas: canvas instanceof HTMLCanvasElementShim ? canvas : canvas.canvas,
			repetition
		};

	}

}

class HTMLCanvasElementShim {

	constructor() {

		this._width = 640;
		this._height = 480;
		this.style = { cssText: '', display: '' };
		this.parentNode = null;
		this._listeners = {};
		this._ctx2d = null;
		this._pixels = new Uint8ClampedArray( this._width * this._height * 4 );

	}

	get width() { return this._width; }
	set width( value ) {

		this._width = Math.max( 1, value | 0 );
		this._resizePixels();

	}

	get height() { return this._height; }
	set height( value ) {

		this._height = Math.max( 1, value | 0 );
		this._resizePixels();

	}

	_resizePixels() {

		this._pixels = new Uint8ClampedArray( this._width * this._height * 4 );

	}

	getContext( type ) {

		if ( type === '2d' ) {

			if ( this._ctx2d == null ) this._ctx2d = new CanvasRenderingContext2DShim( this );
			return this._ctx2d;

		}

		// webgl/webgl2 - return null, TUI mode uses OpenTUI's WebGPU renderer
		return null;

	}

	addEventListener( event, fn ) {

		if ( ! this._listeners[ event ] ) this._listeners[ event ] = [];
		this._listeners[ event ].push( fn );

	}

	removeEventListener( event, fn ) {

		if ( this._listeners[ event ] ) {

			this._listeners[ event ] = this._listeners[ event ].filter( f => f !== fn );

		}

	}

	dispatchEvent() {}

	toDataURL() { return ''; }
	toBlob() {}

}

// ============================================================================
// Image shim
// ============================================================================

class ImageShim {

	constructor() {

		this.width = 0;
		this.height = 0;
		this.src = '';
		this.onload = null;
		this.onerror = null;

	}

}

// ============================================================================
// DOM shims
// ============================================================================

const _globalListeners = {};

const documentShim = {

	createElement( tag ) {

		if ( tag === 'canvas' ) return new HTMLCanvasElementShim();
		if ( tag === 'div' || tag === 'span' || tag === 'pre' ) {

			return {
				style: { cssText: '' },
				innerHTML: '',
				textContent: '',
				appendChild() {},
				removeChild() {},
				addEventListener() {},
				removeEventListener() {},
				parentNode: null,
				children: [],
				classList: { add() {}, remove() {}, toggle() {} }
			};

		}

		return {
			style: {},
			addEventListener() {},
			removeEventListener() {}
		};

	},

	getElementById() { return null; },

	body: {
		appendChild() {},
		removeChild() {},
		innerHTML: '',
		style: {},
		addEventListener() {},
		removeEventListener() {}
	},

	addEventListener( event, fn ) {

		if ( ! _globalListeners[ event ] ) _globalListeners[ event ] = [];
		_globalListeners[ event ].push( fn );

	},

	removeEventListener( event, fn ) {

		if ( _globalListeners[ event ] ) {

			_globalListeners[ event ] = _globalListeners[ event ].filter( f => f !== fn );

		}

	},

	exitPointerLock() {},

	hidden: false

};

const windowShim = {

	innerWidth: 640,
	innerHeight: 480,
	devicePixelRatio: 1,

	addEventListener( event, fn ) {

		if ( ! _globalListeners[ event ] ) _globalListeners[ event ] = [];
		_globalListeners[ event ].push( fn );

	},

	removeEventListener( event, fn ) {

		if ( _globalListeners[ event ] ) {

			_globalListeners[ event ] = _globalListeners[ event ].filter( f => f !== fn );

		}

	},

	location: {
		search: '',
		href: '',
		hostname: 'localhost',
		assign() {},
		replace() {}
	},

	open() {

		// TUI mode has no browser to open external links; return a minimal
		// window handle so menu code can call this without throwing.
		return {
			closed: false,
			focus() {},
			close() { this.closed = true; }
		};

	},

	requestAnimationFrame( fn ) {

		return setTimeout( fn, 16 );

	},

	cancelAnimationFrame( id ) {

		clearTimeout( id );

	}

};

// ============================================================================
// Audio shim (Web Audio API -> terminal audio process bridge)
// ============================================================================

const _tuiAudioDebug = process.env.QUAKE_TUI_AUDIO_DEBUG === '1';
const _tuiAudioUseWorker = process.env.QUAKE_TUI_AUDIO_USE_WORKER !== '0';
const _tuiAudioMaxProcessesEnv = Number.parseInt( process.env.QUAKE_TUI_AUDIO_MAX_PROCS || '24', 10 );
const _tuiAudioMaxProcesses = Number.isFinite( _tuiAudioMaxProcessesEnv ) && _tuiAudioMaxProcessesEnv > 0
	? _tuiAudioMaxProcessesEnv
	: 24;
const _tuiAudioMaxStartsPerWindowEnv = Number.parseInt( process.env.QUAKE_TUI_AUDIO_MAX_STARTS_PER_WINDOW || '6', 10 );
const _tuiAudioStartWindowMsEnv = Number.parseInt( process.env.QUAKE_TUI_AUDIO_START_WINDOW_MS || '80', 10 );
const _tuiAudioDedupMsEnv = Number.parseInt( process.env.QUAKE_TUI_AUDIO_DEDUP_MS || '35', 10 );
const _tuiAudioAsyncLaunch = process.env.QUAKE_TUI_AUDIO_ASYNC_LAUNCH !== '0';
const _tuiAudioChunkFramesEnv = Number.parseInt( process.env.QUAKE_TUI_AUDIO_CHUNK_FRAMES || '1024', 10 );
const _tuiAudioMaxStartsPerWindow = Number.isFinite( _tuiAudioMaxStartsPerWindowEnv ) && _tuiAudioMaxStartsPerWindowEnv > 0
	? _tuiAudioMaxStartsPerWindowEnv
	: 6;
const _tuiAudioStartWindowMs = Number.isFinite( _tuiAudioStartWindowMsEnv ) && _tuiAudioStartWindowMsEnv > 0
	? _tuiAudioStartWindowMsEnv
	: 80;
const _tuiAudioDedupMs = Number.isFinite( _tuiAudioDedupMsEnv ) && _tuiAudioDedupMsEnv >= 0
	? _tuiAudioDedupMsEnv
	: 35;
const _tuiAudioChunkFrames = Number.isFinite( _tuiAudioChunkFramesEnv ) && _tuiAudioChunkFramesEnv >= 128
	? _tuiAudioChunkFramesEnv
	: 1024;
const _tuiAudioPipeMuteMs = 3000;
const _tuiAudioPipeFailureWindowMs = 1200;
const _tuiAudioPipeFailureThreshold = 8;
let _tuiAudioPipeFailureWindowStart = 0;
let _tuiAudioPipeFailureCount = 0;
let _tuiAudioMutedUntilMs = 0;
let _tuiAudioMuteLogged = false;
let _tuiAudioStartWindowStart = 0;
let _tuiAudioStartsInWindow = 0;
let _tuiAudioThrottleLogUntil = 0;
const _tuiAudioRecentBufferStarts = new WeakMap();

function _isBenignPipeError( err ) {

	if ( ! err ) return false;
	const code = err.code || '';
	if ( code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET' )
		return true;
	const message = String( err.message || err );
	return message.includes( 'EPIPE' ) || message.includes( 'broken pipe' );

}

function _isAudioTemporarilyMuted() {

	return Date.now() < _tuiAudioMutedUntilMs;

}

function _logAudioThrottleOnce( reason ) {

	if ( ! _tuiAudioDebug ) return;
	const now = Date.now();
	if ( now < _tuiAudioThrottleLogUntil ) return;
	_tuiAudioThrottleLogUntil = now + 750;
	console.error( '[quake-tui] audio throttled:', reason );

}

function _reserveAudioStart( buffer ) {

	const now = Date.now();

	if ( _tuiAudioDedupMs > 0 && buffer && typeof buffer === 'object' ) {

		const prev = _tuiAudioRecentBufferStarts.get( buffer ) || 0;
		if ( now - prev < _tuiAudioDedupMs ) {

			_logAudioThrottleOnce( 'dedup' );
			return false;

		}

	}

	if ( _tuiAudioMaxStartsPerWindow > 0 ) {

		if ( now - _tuiAudioStartWindowStart > _tuiAudioStartWindowMs ) {

			_tuiAudioStartWindowStart = now;
			_tuiAudioStartsInWindow = 0;

		}

		if ( _tuiAudioStartsInWindow >= _tuiAudioMaxStartsPerWindow ) {

			_logAudioThrottleOnce( 'rate-limit' );
			return false;

		}

		_tuiAudioStartsInWindow ++;

	}

	if ( _tuiAudioDedupMs > 0 && buffer && typeof buffer === 'object' )
		_tuiAudioRecentBufferStarts.set( buffer, now );

	return true;

}

function _noteAudioPipeFailure() {

	const now = Date.now();

	if ( now - _tuiAudioPipeFailureWindowStart > _tuiAudioPipeFailureWindowMs ) {

		_tuiAudioPipeFailureWindowStart = now;
		_tuiAudioPipeFailureCount = 0;

	}

	_tuiAudioPipeFailureCount ++;

	if ( _tuiAudioPipeFailureCount >= _tuiAudioPipeFailureThreshold ) {

		_tuiAudioMutedUntilMs = now + _tuiAudioPipeMuteMs;
		_tuiAudioPipeFailureCount = 0;
		_tuiAudioPipeFailureWindowStart = now;

		if ( _tuiAudioDebug && ! _tuiAudioMuteLogged ) {

			_tuiAudioMuteLogged = true;
			console.error(
				'[quake-tui] Audio backend temporarily muted for',
				_tuiAudioPipeMuteMs,
				'ms due to repeated pipe failures.'
			);

		}

	}

}

function _hasCommand( command ) {

	try {

		const result = spawnSync( 'which', [ command ], { stdio: 'ignore' } );
		return result.status === 0;

	} catch ( e ) {

		return false;

	}

}

const _audioBackend = _hasCommand( 'ffplay' ) ? 'ffplay'
	: ( _hasCommand( 'aplay' ) ? 'aplay' : null );
let _audioBackendWarned = false;

function _clampAudioSample( value ) {

	if ( value > 1 ) return 1;
	if ( value < - 1 ) return - 1;
	return value;

}

function _encodeAudioPayload( floatInterleaved ) {

	if ( _audioBackend === 'ffplay' ) {

		return Buffer.from(
			floatInterleaved.buffer,
			floatInterleaved.byteOffset,
			floatInterleaved.byteLength
		);

	}

	// aplay fallback (16-bit little-endian PCM).
	const out = Buffer.allocUnsafe( floatInterleaved.length * 2 );
	for ( let i = 0; i < floatInterleaved.length; i ++ ) {

		const sample = _clampAudioSample( floatInterleaved[ i ] );
		const int16 = sample < 0
			? Math.round( sample * 32768 )
			: Math.round( sample * 32767 );
		out.writeInt16LE( int16, i * 2 );

	}

	return out;

}

function _spawnRawAudioProcess( sampleRate, channels ) {

	if ( _audioBackend === 'ffplay' ) {

		return spawn(
			'ffplay',
			[
				'-nodisp',
				'-autoexit',
				'-loglevel', 'quiet',
				'-f', 'f32le',
				'-ar', String( sampleRate ),
				'-ac', String( channels ),
				'-'
			],
			{ stdio: [ 'pipe', 'ignore', 'ignore' ] }
		);

	}

	if ( _audioBackend === 'aplay' ) {

		return spawn(
			'aplay',
			[
				'-q',
				'-f', 'S16_LE',
				'-r', String( sampleRate ),
				'-c', String( channels )
			],
			{ stdio: [ 'pipe', 'ignore', 'ignore' ] }
		);

	}

	return null;

}

class AudioNodeShim {

	constructor( context, type ) {

		this.context = context;
		this._type = type;
		this._outputs = new Set();
		this._inputs = new Set();

	}

	connect( target ) {

		if ( target && typeof target === 'object' ) {

			this._outputs.add( target );
			if ( target._inputs && target._inputs.add ) target._inputs.add( this );

		}

		return target;

	}

	disconnect( target ) {

		if ( target == null ) {

			for ( const output of this._outputs ) {

				if ( output._inputs && output._inputs.delete ) output._inputs.delete( this );

			}

			this._outputs.clear();
			return;

		}

		if ( this._outputs.has( target ) ) {

			this._outputs.delete( target );
			if ( target._inputs && target._inputs.delete ) target._inputs.delete( this );

		}

	}

}

class DestinationNodeShim extends AudioNodeShim {

	constructor( context ) {

		super( context, 'destination' );
		this.maxChannelCount = 2;

	}

}

class GainNodeShim extends AudioNodeShim {

	constructor( context ) {

		super( context, 'gain' );
		this.gain = {
			value: 1,
			setValueAtTime: ( value ) => {

				if ( Number.isFinite( value ) ) this.gain.value = value;

			}
		};

	}

}

class StereoPannerNodeShim extends AudioNodeShim {

	constructor( context ) {

		super( context, 'stereo-panner' );
		this.pan = {
			value: 0,
			setValueAtTime: ( value ) => {

				if ( Number.isFinite( value ) ) {

					this.pan.value = Math.max( - 1, Math.min( 1, value ) );

				}

			}
		};

	}

}

class MediaElementSourceNodeShim extends AudioNodeShim {

	constructor( context, mediaElement ) {

		super( context, 'media-element-source' );
		this.mediaElement = mediaElement;

	}

}

class AudioBufferShim {

	constructor( channels, length, sampleRate ) {

		this.numberOfChannels = Math.max( 1, channels | 0 );
		this.length = Math.max( 1, length | 0 );
		this.sampleRate = Math.max( 1, sampleRate | 0 );
		this._channels = Array.from(
			{ length: this.numberOfChannels },
			() => new Float32Array( this.length )
		);

	}

	getChannelData( index ) {

		const safeIndex = Number.isFinite( index ) ? ( index | 0 ) : 0;
		return this._channels[ safeIndex ] || this._channels[ 0 ];

	}

}

class BufferSourceNodeShim extends AudioNodeShim {

	constructor( context ) {

		super( context, 'buffer-source' );
		this.buffer = null;
		this.loop = false;
		this.loopStart = 0;
		this.loopEnd = 0;
		this.playbackRate = {
			value: 1,
			setValueAtTime: ( value ) => {

				if ( Number.isFinite( value ) ) this.playbackRate.value = value;

			}
		};
		this.onended = null;
		this._endedListeners = new Set();
		this._started = false;
		this._stopped = false;
		this._process = null;
		this._delayTimer = null;

	}

	start( when = 0 ) {

		if ( this._started ) return;
		this._started = true;
		this._stopped = false;
		this.context._startBufferSource( this, when );

	}

	stop() {

		if ( this._stopped ) return;
		this._stopped = true;
		this.context._stopBufferSource( this );

	}

	addEventListener( type, fn ) {

		if ( type === 'ended' && typeof fn === 'function' ) {

			this._endedListeners.add( fn );

		}

	}

	removeEventListener( type, fn ) {

		if ( type === 'ended' && typeof fn === 'function' ) {

			this._endedListeners.delete( fn );

		}

	}

	_emitEnded() {

		if ( typeof this.onended === 'function' ) {

			try {

				this.onended();

			} catch ( e ) { /* ignore handler errors */ }

		}

		for ( const fn of this._endedListeners ) {

			try {

				fn();

			} catch ( e ) { /* ignore handler errors */ }

		}

	}

}

class AudioContextShim {

	constructor() {

		this.sampleRate = 44100;
		this.state = 'running';
		this.destination = new DestinationNodeShim( this );
		this._startTime = performance.now();
			this._closed = false;
			this._activeSources = new Set();
			this._mediaElements = new Set();
			this._mixerProcess = null;
			this._mixerBackpressured = false;
			this._mixerTickTimer = null;
			this._mixerChunkFrames = _tuiAudioChunkFrames;
			this._mixerTickMs = Math.max( 5, Math.floor( this._mixerChunkFrames / this.sampleRate * 1000 ) );
			this._workerAudio = null;
			this._workerAudioReady = false;
			this._workerAudioDisabled = ! _tuiAudioUseWorker;
			this._workerAudioVoiceSeq = 1;
			this._workerAudioVoiceMap = new Map();

			if ( ! _audioBackend && ! _audioBackendWarned ) {

			_audioBackendWarned = true;
			console.error( '[quake-tui] No audio backend found. Install ffplay or aplay.' );

		}

	}

	get currentTime() {

		return Math.max( 0, ( performance.now() - this._startTime ) / 1000 );

	}

	createBufferSource() {

		return new BufferSourceNodeShim( this );

	}

	createGain() {

		return new GainNodeShim( this );

	}

	createStereoPanner() {

		return new StereoPannerNodeShim( this );

	}

	createScriptProcessor() {

		return {
			connect() {},
			disconnect() {},
			onaudioprocess: null
		};

	}

	createBuffer( channels, length, sampleRate ) {

		return new AudioBufferShim( channels, length, sampleRate );

	}

	createMediaElementSource( mediaElement ) {

		const source = new MediaElementSourceNodeShim( this, mediaElement );
		if ( mediaElement && mediaElement._registerContext ) {

			mediaElement._registerContext( this );
			this._mediaElements.add( mediaElement );

		}

		return source;

	}

	resume() {

			if ( ! this._closed ) {

				this.state = 'running';
				if ( this._workerAudio && ! this._workerAudioDisabled ) this._postAudioWorker( { type: 'resume' } );
				if ( this._activeSources.size > 0 && ( this._workerAudioDisabled || ! this._workerAudio ) )
					this._ensureMixerPump();

		}
		return Promise.resolve();

	}

	suspend() {

		this.state = 'suspended';
		for ( const source of Array.from( this._activeSources ) ) {

			this._stopBufferSource( source );

		}
		for ( const mediaElement of this._mediaElements ) {

			if ( mediaElement && mediaElement.pause ) mediaElement.pause();

		}
		if ( this._workerAudio && ! this._workerAudioDisabled ) this._postAudioWorker( { type: 'suspend' } );
		this._stopMixerPump();

		return Promise.resolve();

	}

	close() {

		this._closed = true;
		this.state = 'closed';
		for ( const source of Array.from( this._activeSources ) ) {

			this._stopBufferSource( source );

		}
		for ( const mediaElement of this._mediaElements ) {

			if ( mediaElement && mediaElement.pause ) mediaElement.pause();

		}
		if ( this._workerAudio && ! this._workerAudioDisabled ) this._postAudioWorker( { type: 'close' } );
		this._terminateAudioWorker();
		this._stopMixerPump();
		this._stopMixerProcess();
		this._activeSources.clear();
		this._mediaElements.clear();
		return Promise.resolve();

	}

	_startBufferSource( source, when = 0 ) {

		if ( this._closed || this.state !== 'running' ) return;
		if ( ! source || ! source.buffer ) return;
		if ( ! _audioBackend ) return;
		if ( _isAudioTemporarilyMuted() ) return;

		const delayMs = Number.isFinite( when ) && when > 0 ? Math.floor( when * 1000 ) : 0;
		this._scheduleBufferSourceLaunch( source, delayMs );

	}

	_scheduleBufferSourceLaunch( source, delayMs = 0 ) {

		if ( ! source ) return;
		if ( source._delayTimer ) {

			clearTimeout( source._delayTimer );
			source._delayTimer = null;

		}

		const safeDelay = Number.isFinite( delayMs ) && delayMs > 0 ? Math.floor( delayMs ) : 0;
		if ( safeDelay === 0 && _tuiAudioAsyncLaunch !== true ) {

			this._prepareAndLaunchBufferSource( source );
			return;

		}

		source._delayTimer = setTimeout( () => {

			source._delayTimer = null;
			this._prepareAndLaunchBufferSource( source );

		}, safeDelay );

	}

		_prepareAndLaunchBufferSource( source ) {

			if ( this._closed || this.state !== 'running' ) return false;
			if ( ! source || source._stopped || ! source.buffer ) return false;
			if ( ! _audioBackend ) return false;
			if ( _isAudioTemporarilyMuted() ) return false;
			if ( this._activeSources.size >= _tuiAudioMaxProcesses ) return false;
			if ( ! _reserveAudioStart( source.buffer ) ) return false;

			if ( this._queueBufferSourceToAudioWorker( source ) ) return true;
			return this._queueBufferSourceToMixer( source );

		}

		_stopBufferSource( source ) {

		if ( ! source ) return;
			if ( source._delayTimer ) {

			clearTimeout( source._delayTimer );
			source._delayTimer = null;

			}

			if ( source._tuiWorkerVoiceId != null ) {

				this._workerAudioVoiceMap.delete( source._tuiWorkerVoiceId );
				if ( ! this._workerAudioDisabled ) this._postAudioWorker( { type: 'stop', id: source._tuiWorkerVoiceId } );
				source._tuiWorkerVoiceId = null;

			}

				if ( source._process ) {

			try {

				source._process.kill( 'SIGTERM' );

			} catch ( e ) { /* ignore */ }

			source._process = null;

			}

				source._tuiVoice = null;
				this._activeSources.delete( source );
				if ( this._activeSources.size === 0 ) this._stopMixerPump();

			}

		_ensureAudioWorker() {

			if ( this._workerAudioDisabled ) return false;
			if ( ! _audioBackend ) return false;
			if ( _isAudioTemporarilyMuted() ) return false;
			if ( this._workerAudio && this._workerAudio.threadId > 0 ) return true;

			let worker;
			try {

				worker = new NodeWorker( new URL( './tui_audio_worker.js', import.meta.url ), {
					type: 'module'
				} );

			} catch ( error ) {

				this._workerAudioDisabled = true;
				if ( _tuiAudioDebug ) {

					console.error( '[quake-tui] audio worker unavailable, falling back:', error && error.message ? error.message : String( error ) );

				}
				return false;

			}

			this._workerAudio = worker;
			this._workerAudioReady = false;

			worker.on( 'message', ( msg ) => {

				if ( ! msg || typeof msg !== 'object' ) return;

				if ( msg.type === 'ready' ) {

					this._workerAudioReady = true;
					return;

				}

				if ( msg.type === 'ended' ) {

					const source = this._workerAudioVoiceMap.get( msg.id );
					if ( ! source ) return;

					this._workerAudioVoiceMap.delete( msg.id );
					if ( source._tuiWorkerVoiceId === msg.id ) source._tuiWorkerVoiceId = null;
					source._tuiVoice = null;
					this._activeSources.delete( source );

					if ( source._stopped || this._closed || this.state !== 'running' ) return;
					source._emitEnded();
					return;

				}

				if ( msg.type === 'debug' && _tuiAudioDebug && msg.message ) {

					console.error( '[quake-tui] audio worker:', msg.message );
					return;

				}

				if ( msg.type === 'pipe-error' ) {

					_noteAudioPipeFailure();
					return;

				}

			} );

			worker.on( 'error', ( err ) => {

				this._workerAudio = null;
				this._workerAudioReady = false;
				this._workerAudioDisabled = true;
				if ( _tuiAudioDebug ) {

					console.error( '[quake-tui] audio worker error, disabling worker path:', err && err.message ? err.message : String( err ) );

				}

			} );

			worker.on( 'exit', () => {

				this._workerAudio = null;
				this._workerAudioReady = false;

			} );

			this._postAudioWorker( {
				type: 'init',
				sampleRate: this.sampleRate,
				chunkFrames: this._mixerChunkFrames,
				audioBackend: _audioBackend,
				audioDebug: _tuiAudioDebug
			} );

			return true;

		}

		_postAudioWorker( message, transferList ) {

			const worker = this._workerAudio;
			if ( ! worker ) return false;
			try {

				if ( Array.isArray( transferList ) && transferList.length > 0 ) {

					worker.postMessage( message, transferList );

				} else {

					worker.postMessage( message );

				}

				return true;

			} catch ( e ) {

				if ( _tuiAudioDebug ) {

					console.error( '[quake-tui] audio worker postMessage failed:', e && e.message ? e.message : String( e ) );

				}
				return false;

			}

		}

		_terminateAudioWorker() {

			const worker = this._workerAudio;
			this._workerAudio = null;
			this._workerAudioReady = false;
			this._workerAudioVoiceMap.clear();
			if ( ! worker ) return;
			try {

				worker.terminate();

			} catch ( e ) { /* ignore */ }

		}

		_queueBufferSourceToAudioWorker( source ) {

			if ( this._workerAudioDisabled ) return false;
			if ( ! this._ensureAudioWorker() ) return false;
			if ( ! source || ! source.buffer ) return false;

			const mix = this._resolveMix( source );
			const interleaved = this._interleaveBuffer( source.buffer, mix.gain, mix.pan );
			if ( interleaved.length === 0 ) return false;

			const voiceId = this._workerAudioVoiceSeq ++;
			source._tuiWorkerVoiceId = voiceId;
			source._process = null;
			source._tuiVoice = null;
			this._activeSources.add( source );
			this._workerAudioVoiceMap.set( voiceId, source );

			const playbackRate = source.playbackRate && Number.isFinite( source.playbackRate.value ) && source.playbackRate.value > 0
				? source.playbackRate.value
				: 1;

			const ok = this._postAudioWorker(
				{
					type: 'play',
					id: voiceId,
					loop: !! source.loop,
					sampleRate: Math.max( 1, ( source.buffer.sampleRate | 0 ) || this.sampleRate ),
					playbackRate,
					pcm: interleaved.buffer
				},
				[ interleaved.buffer ]
			);

			if ( ! ok ) {

				this._workerAudioVoiceMap.delete( voiceId );
				if ( source._tuiWorkerVoiceId === voiceId ) source._tuiWorkerVoiceId = null;
				this._activeSources.delete( source );
				return false;

			}

			return true;

		}

		_queueBufferSourceToMixer( source ) {

			if ( ! source || ! source.buffer ) return false;
			const buffer = source.buffer;
			const totalFrames = buffer.length | 0;
			if ( totalFrames <= 0 ) return false;

			const mix = this._resolveMix( source );
			const clampedPan = Math.max( - 1, Math.min( 1, mix.pan ) );
			const leftGain = mix.gain * ( clampedPan <= 0 ? 1 : 1 - clampedPan );
			const rightGain = mix.gain * ( clampedPan >= 0 ? 1 : 1 + clampedPan );
			const sourceSampleRate = Math.max( 1, ( buffer.sampleRate | 0 ) || this.sampleRate );
			const playbackRate = source.playbackRate && Number.isFinite( source.playbackRate.value ) && source.playbackRate.value > 0
				? source.playbackRate.value
				: 1;

			source._tuiVoice = {
				left: buffer.getChannelData( 0 ),
				right: buffer.numberOfChannels > 1 ? buffer.getChannelData( 1 ) : buffer.getChannelData( 0 ),
				totalFrames,
				sourceSampleRate,
				playbackRate,
				leftGain,
				rightGain,
				startTime: this.currentTime,
				loop: !! source.loop
			};

			source._process = null;
			this._activeSources.add( source );

			if ( ! this._ensureMixerProcess() ) {

				source._tuiVoice = null;
				this._activeSources.delete( source );
				return false;

			}

			this._ensureMixerPump();
			return true;

		}

		_ensureMixerProcess() {

			if ( this._mixerProcess && ! this._mixerProcess.killed ) return true;
			if ( ! _audioBackend ) return false;
			if ( _isAudioTemporarilyMuted() ) return false;

			let proc = null;
			try {

				proc = _spawnRawAudioProcess( this.sampleRate, 2 );

			} catch ( e ) {

				proc = null;

			}

			if ( ! proc ) return false;

			this._mixerProcess = proc;
			this._mixerBackpressured = false;

			const onProcessError = ( err ) => {

				if ( ! err ) return;

				if ( _isBenignPipeError( err ) ) {

					_noteAudioPipeFailure();
					if ( proc.stdin && ! proc.stdin.destroyed ) {

						try {

							proc.stdin.destroy();

						} catch ( e ) { /* ignore */ }

					}
					return;

				}

				if ( _tuiAudioDebug ) {

					console.error( '[quake-tui] audio mixer process error:', err.message || String( err ) );

				}

			};

			proc.on( 'error', onProcessError );
			proc.on( 'exit', () => {

				if ( this._mixerProcess !== proc ) return;
				this._mixerProcess = null;
				this._mixerBackpressured = false;
				if ( this._closed || this.state !== 'running' ) return;
				if ( this._activeSources.size > 0 ) this._ensureMixerProcess();

			} );

			if ( proc.stdin ) {

				if ( typeof proc.stdin.on === 'function' ) {

					proc.stdin.on( 'error', onProcessError );
					proc.stdin.on( 'drain', () => {

						if ( this._mixerProcess === proc ) this._mixerBackpressured = false;

					} );

				}

			}

			return true;

		}

		_stopMixerProcess() {

			const proc = this._mixerProcess;
			this._mixerProcess = null;
			this._mixerBackpressured = false;
			if ( ! proc ) return;

			try {

				if ( proc.stdin && proc.stdin.writable && ! proc.stdin.destroyed ) proc.stdin.end();

			} catch ( e ) { /* ignore */ }

			try {

				proc.kill( 'SIGTERM' );

			} catch ( e ) { /* ignore */ }

		}

		_ensureMixerPump() {

			if ( this._mixerTickTimer != null ) return;
			if ( this._closed || this.state !== 'running' ) return;

			this._mixerTickTimer = setInterval( () => {

				this._mixerTick();

			}, this._mixerTickMs );

			if ( this._mixerTickTimer && typeof this._mixerTickTimer.unref === 'function' )
				this._mixerTickTimer.unref();

		}

		_stopMixerPump() {

			if ( this._mixerTickTimer == null ) return;
			clearInterval( this._mixerTickTimer );
			this._mixerTickTimer = null;

		}

		_mixerTick() {

			if ( this._closed || this.state !== 'running' ) return;
			if ( this._activeSources.size === 0 ) {

				this._stopMixerPump();
				return;

			}

			if ( _isAudioTemporarilyMuted() ) return;
			if ( this._mixerBackpressured ) return;
			if ( ! this._ensureMixerProcess() ) return;

			const proc = this._mixerProcess;
			if ( ! proc || ! proc.stdin || ! proc.stdin.writable || proc.stdin.destroyed ) return;

			const outFrames = this._mixerChunkFrames;
			const outRate = this.sampleRate;
			const out = new Float32Array( outFrames * 2 );
			const chunkStartTime = this.currentTime;

			for ( const source of Array.from( this._activeSources ) ) {

				if ( ! source || source._stopped ) {

					if ( source ) source._tuiVoice = null;
					this._activeSources.delete( source );
					continue;

				}

				const voice = source._tuiVoice;
				if ( ! voice ) {

					this._activeSources.delete( source );
					continue;

				}

				const finished = this._mixVoiceIntoChunk( voice, out, chunkStartTime, outRate, outFrames );
				if ( finished && voice.loop !== true ) {

					source._tuiVoice = null;
					this._activeSources.delete( source );
					source._emitEnded();

				}

			}

			if ( this._activeSources.size === 0 ) {

				this._stopMixerPump();
				return;

			}

			for ( let i = 0; i < out.length; i ++ ) out[ i ] = _clampAudioSample( out[ i ] );

			const payload = _encodeAudioPayload( out );
			if ( payload.length === 0 ) return;

			try {

				const writeOk = proc.stdin.write( payload );
				if ( writeOk === false ) this._mixerBackpressured = true;

			} catch ( err ) {

				if ( _isBenignPipeError( err ) ) {

					_noteAudioPipeFailure();
					this._mixerBackpressured = false;
					try {

						if ( proc.stdin && ! proc.stdin.destroyed ) proc.stdin.destroy();

					} catch ( e ) { /* ignore */ }

				} else if ( _tuiAudioDebug ) {

					console.error( '[quake-tui] audio mixer write error:', err.message || String( err ) );

				}

			}

		}

		_mixVoiceIntoChunk( voice, out, chunkStartTime, outRate, outFrames ) {

			if ( ! voice || ! voice.left || ! voice.right ) return true;
			const totalFrames = voice.totalFrames | 0;
			if ( totalFrames <= 0 ) return true;

			const playbackRate = voice.playbackRate > 0 ? voice.playbackRate : 1;
			const rateStep = ( voice.sourceSampleRate / outRate ) * playbackRate;
			if ( ! Number.isFinite( rateStep ) || rateStep <= 0 ) return true;

			let srcPos = ( chunkStartTime - voice.startTime ) * voice.sourceSampleRate * playbackRate;
			if ( ! Number.isFinite( srcPos ) ) srcPos = 0;

			const left = voice.left;
			const right = voice.right;
			let finished = false;

			for ( let i = 0; i < outFrames; i ++, srcPos += rateStep ) {

				if ( srcPos < 0 ) continue;

				let pos = srcPos;
				if ( voice.loop === true ) {

					pos %= totalFrames;
					if ( pos < 0 ) pos += totalFrames;

				} else if ( pos >= totalFrames ) {

					finished = true;
					break;

				}

				const idx0 = pos | 0;
				const idx1 = idx0 + 1 < totalFrames ? idx0 + 1 : ( voice.loop === true ? 0 : idx0 );
				const frac = pos - idx0;

				const l0 = left[ idx0 ] || 0;
				const l1 = left[ idx1 ] || 0;
				const r0 = right[ idx0 ] || 0;
				const r1 = right[ idx1 ] || 0;
				const mixedL = l0 + ( l1 - l0 ) * frac;
				const mixedR = r0 + ( r1 - r0 ) * frac;
				const outIdx = i * 2;

				out[ outIdx ] += mixedL * voice.leftGain;
				out[ outIdx + 1 ] += mixedR * voice.rightGain;

			}

			if ( voice.loop !== true && finished !== true ) {

				const chunkEndPos = srcPos;
				if ( chunkEndPos >= totalFrames ) finished = true;

			}

			return finished;

		}

		_launchBufferSource( source, interleaved ) {

		if ( source._stopped || this._closed || this.state !== 'running' ) return false;
		if ( _isAudioTemporarilyMuted() ) return false;
		if ( this._activeSources.size >= _tuiAudioMaxProcesses ) return false;

		let proc;
		try {

			proc = _spawnRawAudioProcess( source.buffer.sampleRate || this.sampleRate, 2 );

		} catch ( e ) {

			proc = null;

		}

		if ( ! proc ) return false;

		this._activeSources.add( source );
		source._process = proc;

		const onProcessError = ( err ) => {

			if ( ! err ) return;

			if ( _isBenignPipeError( err ) ) {

				_noteAudioPipeFailure();
				if ( proc.stdin && ! proc.stdin.destroyed ) {

					try {

						proc.stdin.destroy();

					} catch ( e ) { /* ignore */ }

				}
				return;

			}

			if ( _tuiAudioDebug ) {

				console.error( '[quake-tui] audio process error:', err.message || String( err ) );

			}

		};

		proc.on( 'error', onProcessError );

		proc.on( 'exit', () => {

			if ( source._process !== proc ) return;
			source._process = null;

			if ( source._stopped || this._closed || this.state !== 'running' ) {

				this._activeSources.delete( source );
				return;

			}

			if ( source.loop ) {

				const relaunched = this._launchBufferSource( source, interleaved );
				if ( relaunched ) return;
				this._activeSources.delete( source );
				return;

			}

			this._activeSources.delete( source );
			source._emitEnded();

		} );

		if ( proc.stdin ) {

			if ( typeof proc.stdin.on === 'function' )
				proc.stdin.on( 'error', onProcessError );

			const payload = _encodeAudioPayload( interleaved );
			if ( payload.length > 0 && proc.stdin.writable && ! proc.stdin.destroyed ) {

				try {

					proc.stdin.write( payload );

				} catch ( err ) {

					onProcessError( err );

				}

			}

			if ( proc.stdin.writable && ! proc.stdin.destroyed ) {

				try {

					proc.stdin.end();

				} catch ( err ) {

					onProcessError( err );

				}

			}

		}

		if ( _tuiAudioDebug ) {

			console.error(
				'[quake-tui] audio play',
				'frames=' + ( interleaved.length / 2 ),
				'sampleRate=' + source.buffer.sampleRate,
				'loop=' + ( source.loop ? '1' : '0' )
			);

		}

		return true;

	}

	_resolveMix( source ) {

		const queue = [];
		const visited = new Set();

		for ( const output of source._outputs ) {

			queue.push( { node: output, gain: 1, pan: 0 } );

		}

		while ( queue.length > 0 ) {

			const state = queue.shift();
			if ( ! state || ! state.node || visited.has( state.node ) ) continue;
			visited.add( state.node );

			let gain = state.gain;
			let pan = state.pan;

			if ( state.node._type === 'gain' ) {

				const value = state.node.gain && Number.isFinite( state.node.gain.value )
					? state.node.gain.value
					: 1;
				gain *= value;

			}

			if ( state.node._type === 'stereo-panner' ) {

				const value = state.node.pan && Number.isFinite( state.node.pan.value )
					? state.node.pan.value
					: 0;
				pan = Math.max( - 1, Math.min( 1, value ) );

			}

			if ( state.node === this.destination ) {

				return { gain, pan };

			}

			if ( state.node._outputs ) {

				for ( const output of state.node._outputs ) {

					queue.push( { node: output, gain, pan } );

				}

			}

		}

		return { gain: 1, pan: 0 };

	}

	_interleaveBuffer( buffer, gain, pan ) {

		const frames = buffer.length | 0;
		if ( frames <= 0 ) return new Float32Array( 0 );

		const left = buffer.getChannelData( 0 );
		const right = buffer.numberOfChannels > 1
			? buffer.getChannelData( 1 )
			: left;

		const interleaved = new Float32Array( frames * 2 );
		const clampedPan = Math.max( - 1, Math.min( 1, pan ) );
		const leftGain = gain * ( clampedPan <= 0 ? 1 : 1 - clampedPan );
		const rightGain = gain * ( clampedPan >= 0 ? 1 : 1 + clampedPan );

		for ( let i = 0; i < frames; i ++ ) {

			interleaved[ i * 2 ] = _clampAudioSample( ( left[ i ] || 0 ) * leftGain );
			interleaved[ i * 2 + 1 ] = _clampAudioSample( ( right[ i ] || 0 ) * rightGain );

		}

		return interleaved;

	}

}

class AudioElementShim {

	constructor() {

		this.src = '';
		this.loop = false;
		this.volume = 1;
		this.currentTime = 0;
		this.onended = null;
		this._process = null;
		this._stopped = true;
		this._context = null;

	}

	_registerContext( context ) {

		this._context = context;

	}

	play() {

		this._stopped = false;
		if ( ! this.src ) return Promise.resolve();
		if ( ! _audioBackend || _audioBackend !== 'ffplay' ) return Promise.resolve();

		const startPlayback = () => {

			if ( this._stopped ) return;
			if ( this._process ) {

				try {

					this._process.kill( 'SIGTERM' );

				} catch ( e ) { /* ignore */ }

				this._process = null;

			}

			const args = [ '-nodisp', '-autoexit', '-loglevel', 'quiet' ];
			if ( Number.isFinite( this.volume ) ) {

				const volume = Math.max( 0, this.volume );
				args.push( '-af', 'volume=' + volume.toFixed( 3 ) );

			}
			args.push( this.src );

			this._process = spawn(
				'ffplay',
				args,
				{ stdio: [ 'ignore', 'ignore', 'ignore' ] }
			);

			this._process.on( 'exit', () => {

				if ( this._stopped ) return;
				this._process = null;
				if ( this.loop && ! this._stopped ) {

					startPlayback();
					return;

				}

				if ( typeof this.onended === 'function' ) {

					try {

						this.onended();

					} catch ( e ) { /* ignore */ }

				}

			} );

		};

		startPlayback();
		return Promise.resolve();

	}

	pause() {

		this._stopped = true;
		if ( this._process ) {

			try {

				this._process.kill( 'SIGTERM' );

			} catch ( e ) { /* ignore */ }

			this._process = null;

		}

	}

}

// ============================================================================
// Navigator shim
// ============================================================================

const navigatorShim = {

	userAgent: 'Bun/TUI',
	platform: 'Linux',
	maxTouchPoints: 0,
	getGamepads() { return []; },
	xr: null

};

// ============================================================================
// localStorage shim
// ============================================================================

const _storage = {};
const localStorageShim = {

	getItem( key ) { return _storage[ key ] ?? null; },
	setItem( key, val ) { _storage[ key ] = String( val ); },
	removeItem( key ) { delete _storage[ key ]; },
	clear() { for ( const k in _storage ) delete _storage[ k ]; }

};

// ============================================================================
// URLSearchParams shim (Bun already has this, but just in case)
// ============================================================================

// ============================================================================
// Install globals
// ============================================================================

if ( typeof document === 'undefined' ) globalThis.document = documentShim;
if ( typeof window === 'undefined' ) globalThis.window = windowShim;
if ( typeof navigator === 'undefined' ) globalThis.navigator = navigatorShim;
if ( typeof localStorage === 'undefined' ) globalThis.localStorage = localStorageShim;
if ( typeof Image === 'undefined' ) globalThis.Image = ImageShim;
if ( typeof HTMLCanvasElement === 'undefined' ) globalThis.HTMLCanvasElement = HTMLCanvasElementShim;
if ( typeof Audio === 'undefined' ) globalThis.Audio = AudioElementShim;
if ( typeof AudioContext === 'undefined' ) globalThis.AudioContext = AudioContextShim;
if ( typeof webkitAudioContext === 'undefined' ) globalThis.webkitAudioContext = AudioContextShim;

const windowGlobal = globalThis.window || windowShim;
if ( typeof windowGlobal.Audio === 'undefined' ) windowGlobal.Audio = AudioElementShim;
if ( typeof windowGlobal.AudioContext === 'undefined' ) windowGlobal.AudioContext = AudioContextShim;
if ( typeof windowGlobal.webkitAudioContext === 'undefined' ) windowGlobal.webkitAudioContext = AudioContextShim;
if ( typeof windowGlobal.open !== 'function' ) windowGlobal.open = windowShim.open.bind( windowShim );
if ( typeof globalThis.open !== 'function' ) globalThis.open = windowGlobal.open.bind( windowGlobal );

// Export for use in tui.js
export { documentShim, windowShim, _globalListeners };
