import { useState } from 'react';
import { Card } from './Card';
import { Button } from './Button';
import { COPY } from '../copy';

export interface ErrorPanelProps {
  headline: string;
  cause: string;
  nextStep: string;
  rawDetails?: string;
  onTryAgain?: () => void;
  onHome: () => void;
}

export function ErrorPanel({
  headline,
  cause,
  nextStep,
  rawDetails,
  onTryAgain,
  onHome,
}: ErrorPanelProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <Card className="error-card">
      <h2>{headline}</h2>
      <p className="error-cause">{cause}</p>
      <p className="error-next-step">{nextStep}</p>

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        {onTryAgain ? (
          <>
            <Button variant="primary" onClick={onTryAgain}>
              {COPY.errors.tryAgain}
            </Button>
            <Button variant="secondary" onClick={onHome}>
              {COPY.errors.home}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onHome}>
            {COPY.errors.home}
          </Button>
        )}
      </div>

      {rawDetails && (
        <div className="error-details-collapsible">
          <button
            type="button"
            className="btn-link"
            style={{ padding: 0 }}
            onClick={() => setShowDetails(!showDetails)}
          >
            {showDetails ? 'Hide details' : COPY.errors.details}
          </button>
          {showDetails && <pre>{rawDetails}</pre>}
        </div>
      )}
    </Card>
  );
}
