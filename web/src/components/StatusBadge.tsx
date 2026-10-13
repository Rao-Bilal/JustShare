import React from 'react';

export interface StatusBadgeProps {
  status: 'success' | 'warning' | 'default';
  children: React.ReactNode;
}

export function StatusBadge({ status, children }: StatusBadgeProps) {
  const statusClass = {
    success: 'badge-success',
    warning: 'badge-warning',
    default: '',
  }[status];

  return <span className={`badge ${statusClass}`.trim()}>{children}</span>;
}
