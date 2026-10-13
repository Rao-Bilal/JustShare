import { COPY } from '../copy';

export interface StepperProps {
  currentStep: 1 | 2 | 3;
}

export function Stepper({ currentStep }: StepperProps) {
  const steps = [
    { num: 1, label: COPY.send.stepper.step1 },
    { num: 2, label: COPY.send.stepper.step2 },
    { num: 3, label: COPY.send.stepper.step3 },
  ];

  return (
    <nav className="stepper" aria-label="Transfer steps">
      {steps.map((s) => {
        let stateClass = '';
        if (s.num === currentStep) {
          stateClass = 'active';
        } else if (s.num < currentStep) {
          stateClass = 'completed';
        }
        return (
          <span key={s.num} className={`step-pill ${stateClass}`.trim()}>
            {s.label}
          </span>
        );
      })}
    </nav>
  );
}
