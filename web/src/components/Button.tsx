import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'link' | 'destructive' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

export function Button({
  variant = 'secondary',
  loading = false,
  icon,
  className = '',
  disabled = false,
  children,
  ...props
}: ButtonProps) {
  const variantClass = {
    primary: 'btn-primary',
    secondary: 'btn-secondary',
    link: 'btn-link',
    destructive: 'btn-destructive',
    ghost: 'btn-link',
  }[variant];

  return (
    <button
      className={`btn ${variantClass} ${className}`.trim()}
      disabled={disabled || loading}
      {...props}
    >
      {icon && <span style={{ marginRight: '6px' }}>{icon}</span>}
      {children}
    </button>
  );
}
