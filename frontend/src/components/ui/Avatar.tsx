import React from 'react';
import './Avatar.scss';

interface AvatarProps {
  variant: 'initial' | 'image' | 'icon';
  name?: string;
  src?: string;
  icon?: React.ReactNode;
  size?: number;
  shape?: 'circle' | 'rounded';
  /** Full-screen затемнение поверх аватарки (например DeadIcon в финале). */
  overlay?: React.ReactNode;
  /** Мелкий значок-индикатор в правом нижнем углу (например карандаш-edit в профиле). */
  badge?: React.ReactNode;
  team?: 'mafia' | 'city' | 'neutral';
  onClick?: () => void;
  className?: string;
  ariaLabel?: string;
}

function AvatarImpl({
  variant,
  name,
  src,
  icon,
  size = 40,
  shape = 'circle',
  overlay,
  badge,
  team,
  onClick,
  className,
  ariaLabel,
}: AvatarProps) {
  const classes = [
    'avatar',
    `avatar--${variant}`,
    `avatar--${shape}`,
    team ? `avatar--team-${team}` : '',
    onClick ? 'avatar--interactive' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const initial = name && name.length > 0 ? name.charAt(0).toUpperCase() : '';

  return (
    <div
      className={classes}
      style={{ width: size, height: size }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={ariaLabel ?? name}
    >
      <div className="avatar__inner">
        {variant === 'initial' && <span className="avatar__initial">{initial}</span>}
        {variant === 'image' && src && (
          <img src={src} alt={ariaLabel ?? name ?? ''} className="avatar__image" />
        )}
        {variant === 'icon' && <span className="avatar__icon">{icon}</span>}
        {overlay && <span className="avatar__overlay">{overlay}</span>}
      </div>
      {badge && <span className="avatar__badge">{badge}</span>}
    </div>
  );
}

const Avatar = React.memo(AvatarImpl);
export default Avatar;
