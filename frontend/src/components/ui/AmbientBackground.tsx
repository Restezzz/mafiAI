import React from 'react';
import './AmbientBackground.scss';

interface AmbientBackgroundProps {
  variant:
    | 'night'
    | 'day'
    | 'voting'
    | 'narrator'
    | 'finale-city'
    | 'finale-mafia'
    | 'found'
    | 'clean';
  blobs?: 0 | 1 | 2 | 3;
  className?: string;
}

function AmbientBackgroundImpl({
  variant,
  blobs = 0,
  className,
}: AmbientBackgroundProps) {
  const classes = [
    'ambient-bg',
    `ambient-bg--${variant}`,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <div className={classes} aria-hidden="true" />
      {blobs >= 1 && <div className="ambient-bg__blob ambient-bg__blob--1" aria-hidden="true" />}
      {blobs >= 2 && <div className="ambient-bg__blob ambient-bg__blob--2" aria-hidden="true" />}
      {blobs >= 3 && <div className="ambient-bg__blob ambient-bg__blob--3" aria-hidden="true" />}
    </>
  );
}

const AmbientBackground = React.memo(AmbientBackgroundImpl);
export default AmbientBackground;
