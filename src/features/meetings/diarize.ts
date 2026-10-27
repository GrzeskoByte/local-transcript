/**
 * "Who said what" for a transcribed meeting: decode the recording to 16 kHz
 * mono, run the bundled local speaker-detection engine, give every
 * transcript line the speaker it overlaps most. Runs on this computer only.
 */
import { decodeToMono16k, ASR_SAMPLE_RATE } from '../../audio/decode';
import { encodeWav16 } from '../../asr/wav';
import { assignSpeakers, parseDiarizationOutput, speakersOf } from '../../domain/speakers';
import { getMeeting, updateMeeting } from '../../storage/meetings';
import { listTracks, readRecordingBlob } from '../../storage/recordings';
import { getSegments, setSegmentSpeakers } from '../../storage/transcripts';
import { diarizeProgress, runDiarize } from '../../platform/system';
import type { Meeting } from '../../domain/meeting';

/**
 * Detect speakers; `speakers` = a known count (0 = detect). Reports 0..1.
 * Returns the updated meeting (null when it was deleted meanwhile).
 */
export async function detectSpeakers(
  meetingId: string,
  speakers = 0,
  onProgress?: (ratio: number) => void,
): Promise<Meeting | null> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) return null;
  const tracks = await listTracks(meetingId);
  if (tracks.length !== 1) throw new Error('Speaker detection needs a single-track recording.');
  const blob = await readRecordingBlob(meetingId, meeting.mimeType, tracks[0]!);
  if (!blob) throw new Error('Recording audio not found.');
  onProgress?.(0.02);
  const audio = await decodeToMono16k(blob, (r) => onProgress?.(0.02 + r * 0.08));
  const wav = encodeWav16(audio, ASR_SAMPLE_RATE);
  const poll = setInterval(() => {
    void diarizeProgress()
      .then((p) => onProgress?.(0.1 + Math.min(1, p / 100) * 0.85))
      .catch(() => undefined);
  }, 500);
  let stdout: string;
  try {
    stdout = await runDiarize(wav, speakers);
  } finally {
    clearInterval(poll);
  }
  const turns = parseDiarizationOutput(stdout);
  const segments = await getSegments(meetingId);
  const assigned = assignSpeakers(segments, turns);
  await setSegmentSpeakers(meetingId, new Map(assigned.map((s) => [s.id, s.speaker ?? ''])));
  onProgress?.(1);
  return (
    (await updateMeeting(meetingId, {
      diarization: { at: Date.now(), speakers: speakersOf(assigned).length },
    })) ?? null
  );
}
