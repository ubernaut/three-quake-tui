import { spawn } from 'node:child_process';
import { parentPort } from 'node:worker_threads';

function nowSeconds() {

	if ( typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ) {

		return performance.now() / 1000;

	}

	return Date.now() / 1000;

}

function clampAudioSample( value ) {

	if ( value > 1 ) return 1;
	if ( value < -1 ) return -1;
	return value;

}

function isBenignPipeError( err ) {

	if ( ! err ) return false;
	const code = err.code || '';
	if ( code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET' ) return true;
	const message = String( err.message || err );
	return message.includes( 'EPIPE' ) || message.includes( 'broken pipe' );

}

const state = {
	sampleRate: 44100,
	chunkFrames: 1024,
	audioBackend: null,
	audioDebug: false,
	initialized: false,
	running: true,
	closed: false,
	startTimeSec: nowSeconds(),
	proc: null,
	backpressured: false,
	tickTimer: null,
	voices: new Map()
};

function workerTime() {

	return Math.max( 0, nowSeconds() - state.startTimeSec );

}

function post( msg ) {

	if ( ! parentPort ) return;
	try {

		parentPort.postMessage( msg );

	} catch ( e ) { /* ignore */ }

}

function debug( ...parts ) {

	if ( ! state.audioDebug ) return;
	post( { type: 'debug', message: parts.join( ' ' ) } );

}

function encodeAudioPayload( floatInterleaved ) {

	if ( state.audioBackend === 'ffplay' ) {

		return Buffer.from(
			floatInterleaved.buffer,
			floatInterleaved.byteOffset,
			floatInterleaved.byteLength
		);

	}

	const out = Buffer.allocUnsafe( floatInterleaved.length * 2 );
	for ( let i = 0; i < floatInterleaved.length; i ++ ) {

		const sample = clampAudioSample( floatInterleaved[ i ] );
		const int16 = sample < 0
			? Math.round( sample * 32768 )
			: Math.round( sample * 32767 );
		out.writeInt16LE( int16, i * 2 );

	}

	return out;

}

function spawnRawAudioProcess() {

	if ( state.audioBackend === 'ffplay' ) {

		return spawn(
			'ffplay',
			[
				'-nodisp',
				'-autoexit',
				'-loglevel', 'quiet',
				'-f', 'f32le',
				'-ar', String( state.sampleRate ),
				'-ac', '2',
				'-'
			],
			{ stdio: [ 'pipe', 'ignore', 'ignore' ] }
		);

	}

	if ( state.audioBackend === 'aplay' ) {

		return spawn(
			'aplay',
			[
				'-q',
				'-f', 'S16_LE',
				'-r', String( state.sampleRate ),
				'-c', '2'
			],
			{ stdio: [ 'pipe', 'ignore', 'ignore' ] }
		);

	}

	return null;

}

function ensureProcess() {

	if ( state.proc && ! state.proc.killed ) return true;
	if ( ! state.audioBackend || state.closed ) return false;

	let proc = null;
	try {

		proc = spawnRawAudioProcess();

	} catch ( e ) {

		proc = null;

	}

	if ( ! proc ) return false;

	state.proc = proc;
	state.backpressured = false;

	const onProcessError = ( err ) => {

		if ( ! err ) return;
		if ( isBenignPipeError( err ) ) {

			post( { type: 'pipe-error' } );
			if ( proc.stdin && ! proc.stdin.destroyed ) {

				try {

					proc.stdin.destroy();

				} catch ( e ) { /* ignore */ }

			}
			return;

		}

		debug( 'process error:', err.message || String( err ) );

	};

	proc.on( 'error', onProcessError );
	proc.on( 'exit', () => {

		if ( state.proc !== proc ) return;
		state.proc = null;
		state.backpressured = false;

	} );

	if ( proc.stdin && typeof proc.stdin.on === 'function' ) {

		proc.stdin.on( 'error', onProcessError );
		proc.stdin.on( 'drain', () => {

			if ( state.proc === proc ) state.backpressured = false;

		} );

	}

	debug( 'spawned backend', state.audioBackend );
	return true;

}

function stopProcess() {

	const proc = state.proc;
	state.proc = null;
	state.backpressured = false;
	if ( ! proc ) return;

	try {

		if ( proc.stdin && proc.stdin.writable && ! proc.stdin.destroyed ) proc.stdin.end();

	} catch ( e ) { /* ignore */ }

	try {

		proc.kill( 'SIGTERM' );

	} catch ( e ) { /* ignore */ }

}

function ensureTick() {

	if ( state.tickTimer != null ) return;
	const intervalMs = Math.max( 5, Math.floor( state.chunkFrames / state.sampleRate * 1000 ) );

	state.tickTimer = setInterval( () => {

		mixerTick();

	}, intervalMs );

	if ( state.tickTimer && typeof state.tickTimer.unref === 'function' ) state.tickTimer.unref();

}

function stopTick() {

	if ( state.tickTimer == null ) return;
	clearInterval( state.tickTimer );
	state.tickTimer = null;

}

function mixInterleavedVoiceIntoChunk( voice, out, chunkStartTime, outRate, outFrames ) {

	const data = voice.data;
	const totalFrames = voice.totalFrames | 0;
	if ( ! data || totalFrames <= 0 ) return true;

	const playbackRate = voice.playbackRate > 0 ? voice.playbackRate : 1;
	const rateStep = ( voice.sampleRate / outRate ) * playbackRate;
	if ( ! Number.isFinite( rateStep ) || rateStep <= 0 ) return true;

	let srcPos = ( chunkStartTime - voice.startTime ) * voice.sampleRate * playbackRate;
	if ( ! Number.isFinite( srcPos ) ) srcPos = 0;

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

		const s0L = data[ idx0 * 2 ] || 0;
		const s0R = data[ idx0 * 2 + 1 ] || 0;
		const s1L = data[ idx1 * 2 ] || 0;
		const s1R = data[ idx1 * 2 + 1 ] || 0;

		const outIdx = i * 2;
		out[ outIdx ] += s0L + ( s1L - s0L ) * frac;
		out[ outIdx + 1 ] += s0R + ( s1R - s0R ) * frac;

	}

	if ( voice.loop !== true && finished !== true ) {

		if ( srcPos >= totalFrames ) finished = true;

	}

	return finished;

}

function mixerTick() {

	if ( state.closed || ! state.running ) return;
	if ( state.voices.size === 0 ) {

		stopTick();
		return;

	}

	if ( state.backpressured ) return;
	if ( ! ensureProcess() ) return;

	const proc = state.proc;
	if ( ! proc || ! proc.stdin || ! proc.stdin.writable || proc.stdin.destroyed ) return;

	const outFrames = state.chunkFrames;
	const out = new Float32Array( outFrames * 2 );
	const chunkStartTime = workerTime();

	for ( const [ id, voice ] of Array.from( state.voices.entries() ) ) {

		const finished = mixInterleavedVoiceIntoChunk( voice, out, chunkStartTime, state.sampleRate, outFrames );
		if ( finished && voice.loop !== true ) {

			state.voices.delete( id );
			post( { type: 'ended', id } );

		}

	}

	if ( state.voices.size === 0 ) {

		stopTick();

	}

	for ( let i = 0; i < out.length; i ++ ) out[ i ] = clampAudioSample( out[ i ] );

	const payload = encodeAudioPayload( out );
	if ( payload.length === 0 ) return;

	try {

		const ok = proc.stdin.write( payload );
		if ( ok === false ) state.backpressured = true;

	} catch ( err ) {

		if ( isBenignPipeError( err ) ) {

			post( { type: 'pipe-error' } );
			state.backpressured = false;
			try {

				if ( proc.stdin && ! proc.stdin.destroyed ) proc.stdin.destroy();

			} catch ( e ) { /* ignore */ }

		} else {

			debug( 'write error:', err.message || String( err ) );

		}

	}

}

function onMessage( msg ) {

	if ( ! msg || typeof msg !== 'object' ) return;

	switch ( msg.type ) {

		case 'init': {

			state.sampleRate = Math.max( 1, ( msg.sampleRate | 0 ) || 44100 );
			state.chunkFrames = Math.max( 128, ( msg.chunkFrames | 0 ) || 1024 );
			state.audioBackend = typeof msg.audioBackend === 'string' ? msg.audioBackend : null;
			state.audioDebug = msg.audioDebug === true;
			state.initialized = true;
			state.running = true;
			state.closed = false;
			state.startTimeSec = nowSeconds();
			post( { type: 'ready' } );
			return;

		}

		case 'play': {

			if ( state.closed ) return;
			const pcmBuffer = msg.pcm;
			if ( ! pcmBuffer ) return;
			const data = new Float32Array( pcmBuffer );
			const totalFrames = ( data.length / 2 ) | 0;
			if ( totalFrames <= 0 ) return;
			const id = msg.id | 0;
			if ( id <= 0 ) return;

			state.voices.set( id, {
				id,
				data,
				totalFrames,
				sampleRate: Math.max( 1, ( msg.sampleRate | 0 ) || state.sampleRate ),
				playbackRate: Number.isFinite( msg.playbackRate ) && msg.playbackRate > 0 ? msg.playbackRate : 1,
				loop: msg.loop === true,
				startTime: workerTime()
			} );

			if ( state.running ) ensureTick();
			return;

		}

		case 'stop': {

			const id = msg.id | 0;
			if ( id > 0 ) state.voices.delete( id );
			if ( state.voices.size === 0 ) stopTick();
			return;

		}

		case 'suspend': {

			state.running = false;
			stopTick();
			return;

		}

		case 'resume': {

			state.running = true;
			if ( state.voices.size > 0 ) ensureTick();
			return;

		}

		case 'close': {

			state.closed = true;
			state.running = false;
			state.voices.clear();
			stopTick();
			stopProcess();
			return;

		}

		default:
			return;

	}

}

if ( parentPort ) {

	parentPort.on( 'message', onMessage );

} else {

	process.exit( 0 );

}
