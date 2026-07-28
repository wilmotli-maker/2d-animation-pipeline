import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractTranscript, whisperTranscriber, getTranscriber,
  sidecarPathFor, listAudioFiles, transcribeInputs, AUDIO_EXTS,
} from '../src/transcribe.js';

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'stt-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// --- extractTranscript ---------------------------------------------------

test('extractTranscript returns plain -nt stdout trimmed', () => {
  assert.equal(extractTranscript('  Hello there, Dave.\n'), 'Hello there, Dave.');
});

test('extractTranscript strips leading [timestamp] tokens and joins lines', () => {
  const stdout =
    '[00:00:00.000 --> 00:00:02.500]  Oh hey Dave,\n' +
    "[00:00:02.500 --> 00:00:05.000]  you're making a flyer?\n";
  assert.equal(extractTranscript(stdout), "Oh hey Dave, you're making a flyer?");
});

test('extractTranscript collapses whitespace across multiple lines', () => {
  assert.equal(extractTranscript('one   two\n\n  three  '), 'one two three');
});

test('extractTranscript throws when nothing usable is present', () => {
  assert.throws(() => extractTranscript('   \n\n  '), /could not extract a transcript/);
});

// --- whisperTranscriber --------------------------------------------------

async function seedModel(dir) {
  const model = path.join(dir, 'ggml-base.en.bin');
  await writeFile(model, 'MODEL');
  return model;
}

test('whisperTranscriber builds whisper-cli args and returns extracted text', async () => {
  await withTemp(async (dir) => {
    const model = await seedModel(dir);
    const calls = [];
    const exec = async (bin, args) => {
      calls.push({ bin, args });
      return { code: 0, stdout: 'Transcribed line.\n', stderr: '' };
    };
    const t = whisperTranscriber({ bin: 'whisper-cli', model, exec });
    const res = await t.transcribe('/audio/ART1.wav');

    assert.equal(res.text, 'Transcribed line.');
    assert.equal(calls[0].bin, 'whisper-cli');
    assert.deepEqual(calls[0].args, ['-m', model, '-f', '/audio/ART1.wav', '-nt']);
  });
});

test('whisperTranscriber errors with an install hint when the binary is missing', async () => {
  await withTemp(async (dir) => {
    const model = await seedModel(dir);
    const exec = async () => ({ code: 127, stdout: '', stderr: 'spawn whisper-cli ENOENT' });
    const t = whisperTranscriber({ bin: 'whisper-cli', model, exec });
    await assert.rejects(() => t.transcribe('/a.wav'), /brew install whisper-cpp|WHISPER_CPP_BIN/);
  });
});

test('whisperTranscriber errors with a download hint when the model is missing', async () => {
  await withTemp(async (dir) => {
    const model = path.join(dir, 'nope.bin'); // never created
    const exec = async () => ({ code: 0, stdout: 'x', stderr: '' });
    const t = whisperTranscriber({ bin: 'whisper-cli', model, exec });
    await assert.rejects(() => t.transcribe('/a.wav'), /model not found|WHISPER_CPP_MODEL|--model-file/);
  });
});

test('whisperTranscriber surfaces a non-zero exit as a clear error', async () => {
  await withTemp(async (dir) => {
    const model = await seedModel(dir);
    const exec = async () => ({ code: 3, stdout: '', stderr: 'failed to load audio' });
    const t = whisperTranscriber({ bin: 'whisper-cli', model, exec });
    await assert.rejects(() => t.transcribe('/a.wav'), /whisper failed.*failed to load audio/s);
  });
});

// --- getTranscriber ------------------------------------------------------

test('getTranscriber defaults to whisper', async () => {
  await withTemp(async (dir) => {
    const model = await seedModel(dir);
    const exec = async () => ({ code: 0, stdout: 'ok', stderr: '' });
    const t = getTranscriber(undefined, { model, exec });
    assert.equal((await t.transcribe('/a.wav')).text, 'ok');
  });
});

test('getTranscriber returns a deferred stub for higgsfield', async () => {
  const t = getTranscriber('higgsfield', {});
  await assert.rejects(() => t.transcribe('/a.wav'), /Higgsfield.*not callable|data jobs/i);
});

test('getTranscriber rejects an unknown engine', () => {
  assert.throws(() => getTranscriber('banana', {}), /unknown transcription engine/);
});

// --- sidecar + enumeration ----------------------------------------------

test('sidecarPathFor swaps the extension for .txt', () => {
  assert.equal(sidecarPathFor('/v/ART1.wav'), '/v/ART1.txt');
  assert.equal(sidecarPathFor('/v/clip.mp3'), '/v/clip.txt');
});

test('listAudioFiles returns only recognized audio, sorted, ignoring txt/others', async () => {
  await withTemp(async (dir) => {
    for (const n of ['b.wav', 'a.mp3', 'note.txt', 'img.png', 'c.M4A']) {
      await writeFile(path.join(dir, n), 'x');
    }
    const found = (await listAudioFiles(dir)).map((p) => path.basename(p));
    assert.deepEqual(found, ['a.mp3', 'b.wav', 'c.M4A']);
    assert.ok(AUDIO_EXTS.includes('.wav'));
  });
});

// --- transcribeInputs ----------------------------------------------------

function fakeTranscriber(textFor = (a) => `text for ${path.basename(a)}`) {
  const seen = [];
  return {
    seen,
    transcribe: async (audio) => { seen.push(audio); return { text: textFor(audio), raw: '' }; },
  };
}

test('transcribeInputs writes a .txt sidecar next to each source', async () => {
  await withTemp(async (dir) => {
    const wav = path.join(dir, 'ART1.wav');
    await writeFile(wav, 'x');
    const tr = fakeTranscriber();
    const res = await transcribeInputs({ audios: [wav] }, { transcriber: tr });

    assert.equal(res.length, 1);
    assert.equal(res[0].status, 'transcribed');
    assert.equal(res[0].sidecar, path.join(dir, 'ART1.txt'));
    assert.equal(await readFile(path.join(dir, 'ART1.txt'), 'utf8'), 'text for ART1.wav\n');
  });
});

test('transcribeInputs skips a source whose sidecar exists unless force', async () => {
  await withTemp(async (dir) => {
    const wav = path.join(dir, 'ART1.wav');
    await writeFile(wav, 'x');
    await writeFile(path.join(dir, 'ART1.txt'), 'old transcript\n');

    const tr = fakeTranscriber();
    const skip = await transcribeInputs({ audios: [wav] }, { transcriber: tr });
    assert.equal(skip[0].status, 'skipped');
    assert.equal(tr.seen.length, 0);
    assert.equal(await readFile(path.join(dir, 'ART1.txt'), 'utf8'), 'old transcript\n');

    const forced = await transcribeInputs({ audios: [wav], force: true }, { transcriber: tr });
    assert.equal(forced[0].status, 'transcribed');
    assert.equal(await readFile(path.join(dir, 'ART1.txt'), 'utf8'), 'text for ART1.wav\n');
  });
});

test('transcribeInputs expands --dir over recognized audio', async () => {
  await withTemp(async (dir) => {
    for (const n of ['AI1.wav', 'AI2.wav', 'skip.txt']) await writeFile(path.join(dir, n), 'x');
    const tr = fakeTranscriber();
    const res = await transcribeInputs({ dir }, { transcriber: tr });
    assert.deepEqual(res.map((r) => path.basename(r.sidecar)).sort(), ['AI1.txt', 'AI2.txt']);
  });
});

test('transcribeInputs honours --out only for a single --audio without --dir', async () => {
  await withTemp(async (dir) => {
    const wav = path.join(dir, 'ART1.wav');
    await writeFile(wav, 'x');
    const out = path.join(dir, 'custom.txt');
    const res = await transcribeInputs({ audios: [wav], out }, { transcriber: fakeTranscriber() });
    assert.equal(res[0].sidecar, out);
    assert.equal(await readFile(out, 'utf8'), 'text for ART1.wav\n');

    await assert.rejects(
      () => transcribeInputs({ audios: [wav], dir, out }, { transcriber: fakeTranscriber() }),
      /--out is only valid/,
    );
  });
});

test('transcribeInputs errors when no inputs are given', async () => {
  await assert.rejects(
    () => transcribeInputs({}, { transcriber: fakeTranscriber() }),
    /no audio inputs/,
  );
});
