import React, { useEffect, useState } from 'react';
import { formatBytes } from '../services/format';
import { getFileIconComponent } from './Icons';

interface FilePreviewModalProps {
  file: File | null;
  onClose: () => void;
}

export function FilePreviewModal({ file, onClose }: FilePreviewModalProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!file) {
      setObjectUrl(null);
      setTextContent(null);
      return;
    }

    const type = file.type || '';
    const isImage = type.startsWith('image/');
    const isAudio = type.startsWith('audio/');
    const isVideo = type.startsWith('video/');
    const isText =
      type.startsWith('text/') ||
      ['json', 'md', 'js', 'ts', 'jsx', 'tsx', 'css', 'html', 'xml', 'csv', 'py', 'txt', 'log'].some((ext) =>
        file.name.toLowerCase().endsWith('.' + ext)
      );

    if (isImage || isAudio || isVideo) {
      const url = URL.createObjectURL(file);
      setObjectUrl(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    } else if (isText && file.size < 2 * 1024 * 1024) {
      setLoading(true);
      const reader = new FileReader();
      reader.onload = () => {
        setTextContent(reader.result as string);
        setLoading(false);
      };
      reader.onerror = () => setLoading(false);
      reader.readAsText(file.slice(0, 100000));
    }
  }, [file]);

  if (!file) return null;

  const type = file.type || '';
  const isImage = type.startsWith('image/');
  const isAudio = type.startsWith('audio/');
  const isVideo = type.startsWith('video/');
  const isText = textContent !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-2xl max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col shadow-2xl border border-neutral-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200 bg-neutral-50/70">
          <div className="flex items-center gap-2.5 min-w-0 pr-3">
            <span className="text-neutral-500 shrink-0">
              {getFileIconComponent(file.name, 18)}
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-neutral-900 truncate" title={file.name}>
                {file.name}
              </h3>
              <p className="text-xs text-neutral-500">
                {formatBytes(file.size)} · {file.type || 'Unknown type'}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="w-8 h-8 rounded-full flex items-center justify-center text-neutral-400 hover:text-neutral-700 hover:bg-neutral-200 transition-colors cursor-pointer border-0 shrink-0"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Content body */}
        <div className="p-5 flex-1 overflow-auto flex items-center justify-center min-h-[180px] bg-neutral-50/40">
          {loading ? (
            <p className="text-xs text-neutral-500">Loading preview...</p>
          ) : isImage && objectUrl ? (
            <img
              src={objectUrl}
              alt={file.name}
              className="max-h-[50vh] max-w-full object-contain rounded-lg shadow-xs"
            />
          ) : isVideo && objectUrl ? (
            <video
              src={objectUrl}
              controls
              className="max-h-[50vh] max-w-full rounded-lg"
            />
          ) : isAudio && objectUrl ? (
            <div className="w-full flex flex-col items-center gap-3">
              <audio src={objectUrl} controls className="w-full" />
            </div>
          ) : isText && textContent !== null ? (
            <pre className="text-xs font-mono bg-neutral-900 text-neutral-100 p-3 rounded-lg overflow-auto max-h-[50vh] w-full whitespace-pre-wrap word-break-break-all">
              {textContent}
            </pre>
          ) : (
            <div className="text-center p-6 text-neutral-500 flex flex-col items-center gap-2">
              <span className="text-neutral-400">
                {getFileIconComponent(file.name, 40)}
              </span>
              <p className="text-sm font-medium text-neutral-700">Preview not available</p>
              <p className="text-xs text-neutral-400 max-w-xs">
                This file format cannot be rendered directly in the browser preview.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-neutral-200 flex justify-end bg-neutral-50/70">
          <button
            type="button"
            className="px-4 py-2 text-xs font-medium bg-neutral-900 text-white rounded-xl hover:bg-neutral-800 cursor-pointer border-0"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
