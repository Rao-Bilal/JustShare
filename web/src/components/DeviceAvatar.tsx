import { getAvatarColor, getInitials } from '../services/device';
import { getDeviceTypeIconComponent } from './Icons';

export interface DeviceAvatarProps {
  name: string;
  type?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showBadge?: boolean;
  className?: string;
}

export function DeviceAvatar({
  name,
  type = 'computer',
  size = 'md',
  showBadge = true,
  className = '',
}: DeviceAvatarProps) {
  const { bg, text } = getAvatarColor(name || 'JustShare');
  const initials = getInitials(name || 'JS');

  const sizePx = {
    sm: 32,
    md: 44,
    lg: 56,
    xl: 72,
  }[size];

  const badgeSize = {
    sm: 12,
    md: 16,
    lg: 20,
    xl: 24,
  }[size];

  return (
    <div
      className={`device-avatar-wrapper device-avatar-${size} ${className}`}
      style={{ width: sizePx, height: sizePx }}
    >
      <div
        className="device-avatar-circle"
        style={{
          backgroundColor: bg,
          color: text,
          width: sizePx,
          height: sizePx,
          fontSize: size === 'sm' ? '0.75rem' : size === 'md' ? '0.95rem' : size === 'lg' ? '1.25rem' : '1.6rem',
        }}
      >
        {initials}
      </div>
      {showBadge && (
        <div
          className="device-avatar-badge"
          style={{ width: badgeSize, height: badgeSize }}
          title={type}
        >
          {getDeviceTypeIconComponent(type, badgeSize * 0.75)}
        </div>
      )}
    </div>
  );
}
