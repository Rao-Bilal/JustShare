import React, { useRef, useEffect, useState } from 'react';

export interface CodeInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (code: string) => void;
  disabled?: boolean;
  error?: string | null;
  autoFocus?: boolean;
}

export function CodeInput({
  length = 6,
  value,
  onChange,
  onSubmit,
  disabled = false,
  error = null,
  autoFocus = true,
}: CodeInputProps) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [focusedIndex, setFocusedIndex] = useState<number>(0);

  // Split string into array of single digits
  const digits = Array.from({ length }, (_, i) => value[i] || '');

  useEffect(() => {
    if (autoFocus && inputRefs.current[0]) {
      inputRefs.current[0].focus();
    }
  }, [autoFocus]);

  const handleChange = (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const rawVal = e.target.value.replace(/\D/g, '');
    if (!rawVal) {
      // Empty input
      const newDigits = [...digits];
      newDigits[index] = '';
      const newVal = newDigits.join('');
      onChange(newVal);
      return;
    }

    // Handle single or multi-character insertion (e.g. autofill or typing)
    const char = rawVal[rawVal.length - 1];
    const newDigits = [...digits];
    newDigits[index] = char;
    const newVal = newDigits.join('');
    onChange(newVal);

    if (index < length - 1) {
      inputRefs.current[index + 1]?.focus();
      setFocusedIndex(index + 1);
    } else if (newVal.length === length && onSubmit) {
      onSubmit(newVal);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!digits[index] && index > 0) {
        // Current box is empty, move back and clear previous
        const newDigits = [...digits];
        newDigits[index - 1] = '';
        const newVal = newDigits.join('');
        onChange(newVal);
        inputRefs.current[index - 1]?.focus();
        setFocusedIndex(index - 1);
      } else {
        const newDigits = [...digits];
        newDigits[index] = '';
        onChange(newDigits.join(''));
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      inputRefs.current[index - 1]?.focus();
      setFocusedIndex(index - 1);
    } else if (e.key === 'ArrowRight' && index < length - 1) {
      e.preventDefault();
      inputRefs.current[index + 1]?.focus();
      setFocusedIndex(index + 1);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!pastedData) return;

    onChange(pastedData);
    const targetIdx = Math.min(pastedData.length, length - 1);
    inputRefs.current[targetIdx]?.focus();
    setFocusedIndex(targetIdx);

    if (pastedData.length === length && onSubmit) {
      onSubmit(pastedData);
    }
  };

  return (
    <div className="code-input-container">
      <div className={`code-digit-group ${error ? 'has-error' : ''}`} onPaste={handlePaste}>
        {Array.from({ length }, (_, i) => (
          <input
            key={i}
            ref={(el) => {
              inputRefs.current[i] = el;
            }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            value={digits[i] || ''}
            disabled={disabled}
            aria-label={`Digit ${i + 1} of ${length}`}
            className={`code-digit-box ${focusedIndex === i ? 'is-focused' : ''} ${digits[i] ? 'has-value' : ''}`}
            onChange={(e) => handleChange(i, e)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onFocus={() => setFocusedIndex(i)}
            autoComplete="one-time-code"
          />
        ))}
      </div>
      {error && (
        <p className="code-input-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
