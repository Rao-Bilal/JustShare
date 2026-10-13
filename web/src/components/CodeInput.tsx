import React, { useRef, useEffect } from 'react';

export interface CodeInputProps {
  value: string;
  onChange: (val: string) => void;
  onSubmit: (code: string) => void;
  disabled?: boolean;
  error?: string | null;
}

export function CodeInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  error = null,
}: CodeInputProps) {
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  // 6 digit array
  const digits = Array.from({ length: 6 }, (_, i) => value[i] || '');

  useEffect(() => {
    // Autofocus first empty box or box 0
    if (!disabled) {
      const firstEmpty = digits.findIndex((d) => !d);
      const targetIndex = firstEmpty === -1 ? 5 : firstEmpty;
      inputsRef.current[targetIndex]?.focus();
    }
  }, [disabled]);

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!digits[index] && index > 0) {
        // Move back and clear previous
        const nextDigits = [...digits];
        nextDigits[index - 1] = '';
        const nextVal = nextDigits.join('');
        onChange(nextVal);
        inputsRef.current[index - 1]?.focus();
      } else {
        const nextDigits = [...digits];
        nextDigits[index] = '';
        onChange(nextDigits.join(''));
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputsRef.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < 5) {
      inputsRef.current[index + 1]?.focus();
    }
  };

  const handleChange = (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const rawChar = e.target.value.replace(/\D/g, '');
    if (!rawChar) {
      const nextDigits = [...digits];
      nextDigits[index] = '';
      onChange(nextDigits.join(''));
      return;
    }

    const char = rawChar.slice(-1);
    const nextDigits = [...digits];
    nextDigits[index] = char;
    const nextVal = nextDigits.join('');
    onChange(nextVal);

    if (index < 5) {
      inputsRef.current[index + 1]?.focus();
    } else if (nextVal.length === 6) {
      onSubmit(nextVal);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;

    onChange(pasted);
    const targetIdx = Math.min(pasted.length, 5);
    inputsRef.current[targetIdx]?.focus();

    if (pasted.length === 6) {
      onSubmit(pasted);
    }
  };

  return (
    <div>
      <div className="code-input-row" onPaste={handlePaste}>
        {Array.from({ length: 6 }, (_, i) => (
          <input
            key={i}
            ref={(el) => {
              inputsRef.current[i] = el;
            }}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={1}
            disabled={disabled}
            value={digits[i]}
            aria-label={`Digit ${i + 1} of 6`}
            className="code-input-box"
            onChange={(e) => handleChange(i, e)}
            onKeyDown={(e) => handleKeyDown(i, e)}
          />
        ))}
      </div>
      {error && (
        <div className="code-error-text" role="alert" aria-live="polite">
          {error}
        </div>
      )}
    </div>
  );
}
