import React, { useState, useEffect } from 'react';
import { generateFriendlyName } from '../services/device';
import { Button } from './Button';
import { IconRefreshCw, IconX } from './Icons';

export interface DeviceEditModalProps {
  isOpen: boolean;
  currentName: string;
  onSave: (newName: string) => Promise<void>;
  onClose: () => void;
}

export function DeviceEditModal({
  isOpen,
  currentName,
  onSave,
  onClose,
}: DeviceEditModalProps) {
  const [name, setName] = useState(currentName);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName(currentName);
      setError(null);
    }
  }, [isOpen, currentName]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Device name cannot be empty');
      return;
    }
    if (trimmed.length > 32) {
      setError('Device name must be 32 characters or fewer');
      return;
    }

    try {
      setIsSaving(true);
      setError(null);
      await onSave(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update name');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRandomize = () => {
    setName(generateFriendlyName());
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 id="modal-title" className="modal-title">Rename Device</h3>
          <button
            type="button"
            className="btn-icon-close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <IconX size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <label htmlFor="device-name-input" className="form-label">
              Device Display Name
            </label>
            <div className="input-with-action">
              <input
                id="device-name-input"
                type="text"
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                autoFocus
                placeholder="e.g. Swift Falcon"
              />
              <button
                type="button"
                className="btn-input-action"
                onClick={handleRandomize}
                title="Generate random name"
                aria-label="Generate random name"
              >
                <IconRefreshCw size={16} />
              </button>
            </div>
            <p className="form-hint">
              This is how your device appears to nearby peers on your local network.
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>

          <div className="modal-footer">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={isSaving}>
              Save Name
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
