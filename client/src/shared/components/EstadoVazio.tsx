import type { ReactNode } from 'react';

// M2: the project's empty state is ONE — optional icon, message and optional action.
// `as` and `className` exist so each call site keeps the element and class it already had:
// the class is a contract in the tests (li.muted in the tree, div.nx-empty in the scan,
// span.tl-empty in the timeline). The message renders in <p class="nx-vazio-msg"> because <p>
// brings a 1em margin from the factory.
type Props = {
  message: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
  as?: 'div' | 'li' | 'span';
};

export default function EmptyState({ message, icon, action, className, as = 'div' }: Props) {
  const Tag = as;
  return (
    <Tag className={className}>
      {icon}
      <p className="nx-vazio-msg">{message}</p>
      {action}
    </Tag>
  );
}
