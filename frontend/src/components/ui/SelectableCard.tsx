import React from 'react';
import './SelectableCard.scss';

interface SelectableCardProps {
  children: React.ReactNode;
  state?: 'default' | 'selected' | 'checked-mafia' | 'checked-city';
  disabled?: boolean;
  hidden?: boolean;
  rightSlot?: React.ReactNode;
  onClick?: () => void;
  className?: string;
}

function SelectableCardImpl({
  children,
  state = 'default',
  disabled = false,
  hidden = false,
  rightSlot,
  onClick,
  className,
}: SelectableCardProps) {
  const classes = [
    'selectable-card',
    `selectable-card--${state}`,
    disabled ? 'selectable-card--disabled' : '',
    hidden ? 'selectable-card--hidden' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="selectable-card__body">{children}</span>
      {rightSlot && <span className="selectable-card__right">{rightSlot}</span>}
    </button>
  );
}

const SelectableCard = React.memo(SelectableCardImpl);
export default SelectableCard;
