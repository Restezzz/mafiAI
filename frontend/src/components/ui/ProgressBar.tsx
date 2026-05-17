import React from 'react';
import './ProgressBar.scss';

interface ProgressBarProps {
  value: number;
  variant?: 'default' | 'narrator' | 'votes';
  className?: string;
}

function ProgressBarImpl({
  value,
  variant = 'default',
  className,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const classes = [
    'progress-bar',
    `progress-bar--${variant}`,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-bar__fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}

const ProgressBar = React.memo(ProgressBarImpl);
export default ProgressBar;
