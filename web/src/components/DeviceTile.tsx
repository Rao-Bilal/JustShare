import { DeviceAvatar } from './DeviceAvatar';
import { IconArrowRight } from './Icons';

export interface DeviceTileProps {
  id: string;
  name: string;
  type: string;
  onClick: () => void;
  isConnecting?: boolean;
}

export function DeviceTile({
  name,
  type,
  onClick,
  isConnecting = false,
}: DeviceTileProps) {
  return (
    <button
      type="button"
      className={`device-tile ${isConnecting ? 'is-connecting' : ''}`}
      onClick={onClick}
      disabled={isConnecting}
      aria-label={`Send files to ${name}`}
    >
      <DeviceAvatar name={name} type={type} size="md" />
      <div className="device-tile-content">
        <span className="device-tile-name" title={name}>
          {name}
        </span>
        <span className="device-tile-type">
          {isConnecting ? 'Connecting…' : `${type.charAt(0).toUpperCase() + type.slice(1)} · Ready`}
        </span>
      </div>
      <div className="device-tile-action">
        {isConnecting ? (
          <span className="btn-spinner" aria-hidden="true" />
        ) : (
          <IconArrowRight size={18} className="device-tile-arrow" />
        )}
      </div>
    </button>
  );
}
