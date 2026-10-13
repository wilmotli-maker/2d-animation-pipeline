// src/edit-ui/trim-media.js
// Build + run the ffmpeg commands that trim a window out of the source / speech-ref and
// pad the edges (freeze-frame video, silent audio) so the clip reaches its full centered
// duration. Arg building is a pure function so it can be asserted without running ffmpeg.
const t3 = (n) => Number(n).toFixed(3);

// span = sourceSpan length (real footage); padStart/padEnd = synthetic seconds to add.
export function trimArgs({ input, output, start, span, padStart = 0, padEnd = 0, video = true, audio = false }) {
  const vf = [];
  if (padStart > 0) vf.push(`tpad=start_duration=${t3(padStart)}:start_mode=clone`);
  if (padEnd > 0) vf.push(`tpad=stop_duration=${t3(padEnd)}:stop_mode=clone`);
  const args = ['-ss', t3(start), '-i', input, '-t', t3(span)];
  if (!audio) args.push('-an');
  if (vf.length) args.push('-vf', vf.join(','));
  if (audio) {
    const af = [];
    if (padStart > 0) af.push(`adelay=${Math.round(padStart * 1000)}:all=1`);
    if (padEnd > 0) af.push(`apad=pad_dur=${t3(padEnd)}`);
    if (af.length) args.push('-af', af.join(','));
    args.push('-c:a', 'aac');
  }
  args.push('-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', output);
  return args;
}

async function ffRun(ffmpeg, args) { await ffmpeg(['-v', 'error', '-y', ...args]); }

export async function trimPadVideo(ffmpeg, { input, output, sourceSpan, pad }) {
  const [s, e] = sourceSpan;
  await ffRun(ffmpeg, trimArgs({ input, output, start: s, span: e - s, padStart: pad.start, padEnd: pad.end, video: true, audio: false }));
  return output;
}

export async function trimPadSpeech(ffmpeg, { input, output, sourceSpan, pad }) {
  const [s, e] = sourceSpan;
  await ffRun(ffmpeg, trimArgs({ input, output, start: s, span: e - s, padStart: pad.start, padEnd: pad.end, video: true, audio: true }));
  return output;
}

export async function extractFrame(ffmpeg, { input, time, output }) {
  await ffRun(ffmpeg, ['-ss', t3(time), '-i', input, '-frames:v', '1', output]);
  return output;
}
