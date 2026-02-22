// Browser API shims for running Quake in terminal via Bun + OpenTUI
// Must be imported BEFORE any engine modules

import { spawn, spawnSync } from 'node:child_process';

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
		hostname: 'localhost'
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

		if ( ! this._closed ) this.state = 'running';
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
		this._activeSources.clear();
		this._mediaElements.clear();
		return Promise.resolve();

	}

	_startBufferSource( source, when = 0 ) {

		if ( this._closed || this.state !== 'running' ) return;
		if ( ! source || ! source.buffer ) return;
		if ( ! _audioBackend ) return;

		const mix = this._resolveMix( source );
		const interleaved = this._interleaveBuffer( source.buffer, mix.gain, mix.pan );

		if ( interleaved.length === 0 ) return;

		const delayMs = Number.isFinite( when ) && when > 0 ? Math.floor( when * 1000 ) : 0;
		if ( delayMs > 0 ) {

			source._delayTimer = setTimeout( () => {

				source._delayTimer = null;
				this._launchBufferSource( source, interleaved );

			}, delayMs );
			return;

		}

		this._launchBufferSource( source, interleaved );

	}

	_stopBufferSource( source ) {

		if ( ! source ) return;
		if ( source._delayTimer ) {

			clearTimeout( source._delayTimer );
			source._delayTimer = null;

		}

		if ( source._process ) {

			try {

				source._process.kill( 'SIGTERM' );

			} catch ( e ) { /* ignore */ }

			source._process = null;

		}

		this._activeSources.delete( source );

	}

	_launchBufferSource( source, interleaved ) {

		if ( source._stopped || this._closed || this.state !== 'running' ) return;

		let proc;
		try {

			proc = _spawnRawAudioProcess( source.buffer.sampleRate || this.sampleRate, 2 );

		} catch ( e ) {

			proc = null;

		}

		if ( ! proc ) return;

		this._activeSources.add( source );
		source._process = proc;

		proc.on( 'exit', () => {

			if ( source._process !== proc ) return;
			source._process = null;

			if ( source._stopped || this._closed || this.state !== 'running' ) {

				this._activeSources.delete( source );
				return;

			}

			if ( source.loop ) {

				this._launchBufferSource( source, interleaved );
				return;

			}

			this._activeSources.delete( source );
			source._emitEnded();

		} );

		if ( proc.stdin ) {

			const payload = _encodeAudioPayload( interleaved );
			if ( payload.length > 0 ) proc.stdin.write( payload );
			proc.stdin.end();

		}

		if ( _tuiAudioDebug ) {

			console.error(
				'[quake-tui] audio play',
				'frames=' + ( interleaved.length / 2 ),
				'sampleRate=' + source.buffer.sampleRate,
				'loop=' + ( source.loop ? '1' : '0' )
			);

		}

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

// Export for use in tui.js
export { documentShim, windowShim, _globalListeners };
