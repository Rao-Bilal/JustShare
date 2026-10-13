import React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  secondary?: boolean;
  children: React.ReactNode;
}

export function Card({ secondary = false, className = '', children, ...props }: CardProps) {
  return (
    <div className={`card ${secondary ? 'card-secondary' : ''} ${className}`.trim()} {...props}>
      {children}
    </div>
  );
}
