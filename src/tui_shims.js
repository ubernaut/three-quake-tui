// Browser API shims for running Quake in terminal via Bun + OpenTUI
// Must be imported BEFORE any engine modules

// Mark TUI mode globally
globalThis.__TUI_MODE = true;

// ============================================================================
// Minimal Canvas 2D shim
// The engine uses Canvas 2D for HUD/menu/console overlay.
// In TUI mode we stub it out - the 3D scene renders via OpenTUI.
// ============================================================================

class CanvasRenderingContext2DShim {

	constructor( canvas ) {

		this.canvas = canvas;
		this.fillStyle = '#000';
		this.strokeStyle = '#000';
		this.globalAlpha = 1;
		this.globalCompositeOperation = 'source-over';
		this.imageSmoothingEnabled = true;
		this.font = '10px sans-serif';
		this.textAlign = 'start';
		this.textBaseline = 'alphabetic';

	}

	clearRect() {}
	fillRect() {}
	strokeRect() {}
	fillText() {}
	strokeText() {}
	measureText() { return { width: 0 }; }
	drawImage() {}
	getImageData( x, y, w, h ) {

		return { data: new Uint8ClampedArray( w * h * 4 ), width: w, height: h };

	}
	createImageData( w, h ) {

		if ( typeof w === 'object' ) { h = w.height; w = w.width; }
		return { data: new Uint8ClampedArray( w * h * 4 ), width: w, height: h };

	}
	putImageData() {}
	setTransform() {}
	resetTransform() {}
	save() {}
	restore() {}
	scale() {}
	translate() {}
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
	createLinearGradient() {

		return { addColorStop() {} };

	}
	createRadialGradient() {

		return { addColorStop() {} };

	}
	createPattern() { return null; }

}

class HTMLCanvasElementShim {

	constructor() {

		this.width = 640;
		this.height = 480;
		this.style = { cssText: '', display: '' };
		this.parentNode = null;
		this._listeners = {};

	}

	getContext( type ) {

		if ( type === '2d' ) {

			return new CanvasRenderingContext2DShim( this );

		}

		// webgl/webgl2 - return null, TUI mode uses OpenTUI's WebGPU renderer
		return null;

	}

	addEventListener( event, fn, opts ) {

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
// Audio shim (Web Audio API stub)
// ============================================================================

class AudioContextShim {

	constructor() {

		this.sampleRate = 44100;
		this.currentTime = 0;
		this.state = 'suspended';
		this.destination = { maxChannelCount: 2 };

	}

	createBufferSource() {

		return {
			buffer: null,
			connect() {},
			start() {},
			stop() {},
			addEventListener() {},
			removeEventListener() {}
		};

	}

	createGain() {

		return {
			gain: { value: 1, setValueAtTime() {} },
			connect() {},
			disconnect() {}
		};

	}

	createScriptProcessor() {

		return {
			connect() {},
			disconnect() {},
			onaudioprocess: null
		};

	}

	createBuffer( channels, length, sampleRate ) {

		const data = new Float32Array( length );
		return {
			numberOfChannels: channels,
			length: length,
			sampleRate: sampleRate,
			getChannelData() { return data; }
		};

	}

	resume() { return Promise.resolve(); }
	suspend() { return Promise.resolve(); }
	close() { return Promise.resolve(); }

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
if ( typeof AudioContext === 'undefined' ) globalThis.AudioContext = AudioContextShim;
if ( typeof webkitAudioContext === 'undefined' ) globalThis.webkitAudioContext = AudioContextShim;

// Export for use in tui.js
export { documentShim, windowShim, _globalListeners };
