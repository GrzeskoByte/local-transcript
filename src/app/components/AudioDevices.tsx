import { useCallback, useEffect, useState } from 'react';
import {
  canChoosePlaybackOutput,
  getMicrophoneDevice,
  getPlaybackDevice,
  getSystemOutput,
  listDevices,
  resolveDevice,
  setMicrophoneDevice,
  setPlaybackDevice,
  setSystemOutput,
  type DeviceList,
  type SavedDevice,
} from '../../audio/devices';
import { systemAudioOutputs, type SystemAudioOutput } from '../../audio/system-audio';
import { primeMicrophonePermission } from '../../audio/permissions';

const EMPTY: DeviceList = { options: [], labelsHidden: false };

interface Props {
  /** Recording input (Speaker, Mic + Device). */
  microphone?: boolean;
  /** Output whose sound Device Audio records (Linux desktop only). */
  systemOutput?: boolean;
  /** Where recordings play (engines with setSinkId only). */
  playback?: boolean;
  /** Called after the playback output changed (re-route open players). */
  onPlaybackChange?: () => void;
}

/**
 * Input/output pickers. Every instance reads and writes the same prefs, so a
 * choice made on New Meeting shows up in Settings and vice versa.
 */
export function AudioDevicePickers({ microphone, systemOutput, playback, onPlaybackChange }: Props): React.JSX.Element | null {
  const [inputs, setInputs] = useState<DeviceList>(EMPTY);
  const [outputs, setOutputs] = useState<DeviceList>(EMPTY);
  const [sinks, setSinks] = useState<SystemAudioOutput[]>([]);
  const [mic, setMic] = useState<SavedDevice | null>(getMicrophoneDevice);
  const [sink, setSink] = useState(getSystemOutput);
  const [speaker, setSpeaker] = useState<SavedDevice | null>(getPlaybackDevice);
  const [granting, setGranting] = useState(false);
  const showPlayback = playback === true && canChoosePlaybackOutput();

  const refresh = useCallback(async () => {
    if (microphone) setInputs(await listDevices('audioinput'));
    if (showPlayback) setOutputs(await listDevices('audiooutput'));
    if (systemOutput) setSinks(await systemAudioOutputs());
  }, [microphone, showPlayback, systemOutput]);

  useEffect(() => {
    void refresh();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = () => void refresh();
    md.addEventListener('devicechange', onChange);
    return () => md.removeEventListener('devicechange', onChange);
  }, [refresh]);

  const grant = (): void => {
    setGranting(true);
    void primeMicrophonePermission()
      .then(() => refresh())
      .finally(() => setGranting(false));
  };

  const showSinks = systemOutput === true && sinks.length > 0;
  if (!microphone && !showSinks && !(showPlayback && outputs.options.length > 0)) return null;

  const micValue = resolveDevice(mic, inputs.options) ?? (mic ? `missing:${mic.deviceId}` : '');
  const speakerValue = resolveDevice(speaker, outputs.options) ?? (speaker ? `missing:${speaker.deviceId}` : '');
  const defaultSink = sinks.find((s) => s.isDefault);
  const sinkMissing = sink !== '' && sinks.length > 0 && !sinks.some((s) => s.name === sink);

  return (
    <div className="device-pickers">
      {microphone && (
        <label className="device-picker">
          <span className="field-label">Microphone</span>
          <select
            className="input"
            value={micValue}
            onChange={(e) => {
              const opt = inputs.options.find((o) => o.id === e.target.value);
              const next = opt ? { deviceId: opt.id, label: inputs.labelsHidden ? '' : opt.label } : null;
              setMicrophoneDevice(next);
              setMic(next);
            }}
          >
            <option value="">System default</option>
            {inputs.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
            {micValue.startsWith('missing:') && (
              <option value={micValue}>{mic?.label || 'Saved microphone'} (not connected)</option>
            )}
          </select>
          {micValue.startsWith('missing:') && (
            <small className="warn">This microphone isn’t connected — the system default will be used.</small>
          )}
          {inputs.labelsHidden && (
            <small className="muted">
              Device names appear after microphone access is granted.{' '}
              <button type="button" className="link-btn" disabled={granting} onClick={grant}>
                {granting ? 'Requesting…' : 'Show names'}
              </button>
            </small>
          )}
        </label>
      )}

      {showSinks && (
        <label className="device-picker">
          <span className="field-label">Record sound from</span>
          <select
            className="input"
            value={sinkMissing ? `missing:${sink}` : sink}
            onChange={(e) => {
              const next = e.target.value.startsWith('missing:') ? sink : e.target.value;
              setSystemOutput(next);
              setSink(next);
            }}
          >
            <option value="">Default output{defaultSink ? ` (${defaultSink.description})` : ''}</option>
            {sinks.map((s) => (
              <option key={s.name} value={s.name}>
                {s.description}
              </option>
            ))}
            {sinkMissing && <option value={`missing:${sink}`}>{sink} (not connected)</option>}
          </select>
          {sinkMissing ? (
            <small className="warn">This output isn’t available — the default output will be recorded.</small>
          ) : (
            <small className="muted">Device Audio records everything played on this output.</small>
          )}
        </label>
      )}

      {showPlayback && outputs.options.length > 0 && (
        <label className="device-picker">
          <span className="field-label">Play recordings on</span>
          <select
            className="input"
            value={speakerValue}
            onChange={(e) => {
              const opt = outputs.options.find((o) => o.id === e.target.value);
              const next = opt ? { deviceId: opt.id, label: opt.label } : null;
              setPlaybackDevice(next);
              setSpeaker(next);
              onPlaybackChange?.();
            }}
          >
            <option value="">System default</option>
            {outputs.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
            {speakerValue.startsWith('missing:') && (
              <option value={speakerValue}>{speaker?.label || 'Saved output'} (not connected)</option>
            )}
          </select>
        </label>
      )}
    </div>
  );
}
