/**
 * Редактор JSON-condition для StoryTransition (этап 6.2).
 *
 * Поддерживает все атомарные типы из backend services/story_runtime.py
 * `_evaluate_condition` (winner / phase_number / vote_tie / died_role /
 * death_cause / role_alive / role_dead / step_var) и композитные
 * (all / any / not) с вложенностью.
 *
 * Контракт: value=null означает «безусловный transition» (fallback). Если
 * пользователь выбирает тип в селекторе — value перестраивается под
 * минимально валидную форму этого типа. onChange всегда даёт либо null,
 * либо валидный объект с полем `type`.
 *
 * Это не строгая валидация (backend всё равно проверяет), а UX-помощник:
 * select по типу + соответствующие поля.
 */
import React, { useCallback } from 'react';

export type Condition =
  | { type: 'winner'; team: string | null }
  | { type: 'phase_number'; op: ComparisonOp; value: number }
  | { type: 'vote_tie' }
  | { type: 'died_role'; role_slug: string }
  | { type: 'death_cause'; value: string }
  | { type: 'role_alive'; role_slug: string }
  | { type: 'role_dead'; role_slug: string }
  | {
      type: 'step_var';
      key: string;
      op: ComparisonOp;
      value: string | number | boolean | null;
    }
  | { type: 'all'; conditions: Condition[] }
  | { type: 'any'; conditions: Condition[] }
  | { type: 'not'; condition: Condition | null };

export type ComparisonOp = '==' | '!=' | '>' | '>=' | '<' | '<=';

const COMPARISON_OPS: ComparisonOp[] = ['==', '!=', '>', '>=', '<', '<='];

const TYPES: Array<{ value: Condition['type']; label: string }> = [
  { value: 'winner', label: 'winner — победила команда' },
  { value: 'phase_number', label: 'phase_number — номер фазы' },
  { value: 'vote_tie', label: 'vote_tie — ничья на голосовании' },
  { value: 'died_role', label: 'died_role — погибла роль' },
  { value: 'death_cause', label: 'death_cause — причина смерти' },
  { value: 'role_alive', label: 'role_alive — роль ещё жива' },
  { value: 'role_dead', label: 'role_dead — роль мертва' },
  { value: 'step_var', label: 'step_var — произвольная переменная' },
  { value: 'all', label: 'all — все вложенные истинны' },
  { value: 'any', label: 'any — хотя бы одно вложенное' },
  { value: 'not', label: 'not — отрицание' },
];

// Дефолтные значения для каждого типа.
function defaultsFor(type: Condition['type']): Condition {
  switch (type) {
    case 'winner': return { type, team: 'city' };
    case 'phase_number': return { type, op: '>=', value: 1 };
    case 'vote_tie': return { type };
    case 'died_role': return { type, role_slug: '' };
    case 'death_cause': return { type, value: 'vote' };
    case 'role_alive': return { type, role_slug: '' };
    case 'role_dead': return { type, role_slug: '' };
    case 'step_var': return { type, key: '', op: '==', value: '' };
    case 'all': return { type, conditions: [] };
    case 'any': return { type, conditions: [] };
    case 'not': return { type, condition: null };
  }
}

interface Props {
  value: Condition | null;
  onChange: (next: Condition | null) => void;
  /** Глубина вложенности — для отступов и предотвращения бесконечной рекурсии UI. */
  depth?: number;
}

export default function ConditionEditor({ value, onChange, depth = 0 }: Props) {
  const handleTypeChange = useCallback(
    (newType: Condition['type'] | '') => {
      if (newType === '') {
        onChange(null);
        return;
      }
      onChange(defaultsFor(newType));
    },
    [onChange],
  );

  const wrapperStyle: React.CSSProperties = {
    padding: 8,
    border: '1px solid #2a2d33',
    borderRadius: 4,
    background: depth === 0 ? '#0f1115' : '#1a1d22',
    marginLeft: depth > 0 ? 12 : 0,
  };

  const inputStyle: React.CSSProperties = {
    padding: '4px 6px',
    background: '#0a0b0e',
    border: '1px solid #2a2d33',
    borderRadius: 3,
    color: '#e8e9eb',
    fontSize: 12,
    minWidth: 80,
  };

  return (
    <div style={wrapperStyle}>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, opacity: 0.7 }}>Тип</span>
        <select
          value={value?.type ?? ''}
          onChange={(e) => handleTypeChange(e.target.value as Condition['type'] | '')}
          style={inputStyle}
        >
          <option value="">— безусловный (null) —</option>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </label>

      {value && (
        <div style={{ marginTop: 6 }}>
          <ConditionFields
            value={value}
            onChange={onChange}
            depth={depth}
            inputStyle={inputStyle}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Подформы по типу.
// ---------------------------------------------------------------------------
function ConditionFields({
  value,
  onChange,
  depth,
  inputStyle,
}: {
  value: Condition;
  onChange: (next: Condition) => void;
  depth: number;
  inputStyle: React.CSSProperties;
}) {
  const lblStyle: React.CSSProperties = {
    display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
    marginTop: 4, fontSize: 12,
  };

  switch (value.type) {
    case 'winner':
      return (
        <label style={lblStyle}>
          <span style={{ opacity: 0.7 }}>team</span>
          <input
            type="text"
            value={value.team ?? ''}
            placeholder="city / mafia / maniac (пусто = любая)"
            onChange={(e) => onChange({ ...value, team: e.target.value || null })}
            style={inputStyle}
          />
        </label>
      );
    case 'phase_number':
      return (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, opacity: 0.7 }}>phase_number</span>
          <select
            value={value.op}
            onChange={(e) => onChange({ ...value, op: e.target.value as ComparisonOp })}
            style={inputStyle}
          >
            {COMPARISON_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
          </select>
          <input
            type="number"
            value={value.value}
            onChange={(e) => onChange({ ...value, value: Number(e.target.value) })}
            style={inputStyle}
          />
        </div>
      );
    case 'vote_tie':
      return <span style={{ fontSize: 11, opacity: 0.7 }}>(без параметров)</span>;
    case 'died_role':
    case 'role_alive':
    case 'role_dead':
      return (
        <label style={lblStyle}>
          <span style={{ opacity: 0.7 }}>role_slug</span>
          <input
            type="text"
            value={value.role_slug}
            placeholder="sheriff / mafia / doctor / ..."
            onChange={(e) => onChange({ ...value, role_slug: e.target.value })}
            style={inputStyle}
          />
        </label>
      );
    case 'death_cause':
      return (
        <label style={lblStyle}>
          <span style={{ opacity: 0.7 }}>value</span>
          <select
            value={value.value}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
            style={inputStyle}
          >
            <option value="vote">vote (дневное голосование)</option>
            <option value="night">night (ночное убийство)</option>
            <option value="maniac">maniac</option>
          </select>
        </label>
      );
    case 'step_var':
      return (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, opacity: 0.7 }}>step_var</span>
          <input
            type="text"
            placeholder="key"
            value={value.key}
            onChange={(e) => onChange({ ...value, key: e.target.value })}
            style={inputStyle}
          />
          <select
            value={value.op}
            onChange={(e) => onChange({ ...value, op: e.target.value as ComparisonOp })}
            style={inputStyle}
          >
            {COMPARISON_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
          </select>
          <input
            type="text"
            placeholder="value (string/number)"
            value={value.value === null ? '' : String(value.value)}
            onChange={(e) => {
              const raw = e.target.value;
              // Простейший type coercion: если число — то number, иначе string.
              const n = Number(raw);
              const coerced =
                raw === '' ? '' : !Number.isNaN(n) && raw.trim() !== '' ? n : raw;
              onChange({ ...value, value: coerced });
            }}
            style={inputStyle}
          />
        </div>
      );
    case 'all':
    case 'any':
      return (
        <CompositeChildren
          value={value}
          onChange={onChange}
          depth={depth}
        />
      );
    case 'not':
      return (
        <div style={{ marginTop: 4 }}>
          <span style={{ fontSize: 11, opacity: 0.7 }}>NOT(</span>
          <ConditionEditor
            value={value.condition}
            onChange={(c) => onChange({ ...value, condition: c })}
            depth={depth + 1}
          />
          <span style={{ fontSize: 11, opacity: 0.7 }}>)</span>
        </div>
      );
  }
}

function CompositeChildren({
  value,
  onChange,
  depth,
}: {
  value: { type: 'all' | 'any'; conditions: Condition[] };
  onChange: (next: Condition) => void;
  depth: number;
}) {
  return (
    <div style={{ marginTop: 4 }}>
      {value.conditions.length === 0 && (
        <div style={{ fontSize: 11, opacity: 0.6, fontStyle: 'italic' }}>
          (пусто — добавьте вложенные условия ниже)
        </div>
      )}
      {value.conditions.map((c, idx) => (
        <div key={idx} style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 10, opacity: 0.5 }}>
              [{idx}] {value.type === 'all' ? 'AND' : 'OR'}
            </span>
            <button
              type="button"
              onClick={() => {
                const next = value.conditions.slice();
                next.splice(idx, 1);
                onChange({ ...value, conditions: next });
              }}
              style={{
                fontSize: 10, padding: '2px 6px',
                background: '#3a1d22', border: '1px solid #5a2d33',
                color: '#e89595', borderRadius: 3, cursor: 'pointer',
              }}
            >
              ✕ удалить
            </button>
          </div>
          <ConditionEditor
            value={c}
            onChange={(updated) => {
              const next = value.conditions.slice();
              if (updated == null) {
                next.splice(idx, 1);
              } else {
                next[idx] = updated;
              }
              onChange({ ...value, conditions: next });
            }}
            depth={depth + 1}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          onChange({
            ...value,
            conditions: [...value.conditions, defaultsFor('phase_number')],
          });
        }}
        style={{
          marginTop: 6, fontSize: 11, padding: '3px 8px',
          background: '#1a3a22', border: '1px solid #2a5a33',
          color: '#a4e8b8', borderRadius: 3, cursor: 'pointer',
        }}
      >
        + добавить условие
      </button>
    </div>
  );
}
