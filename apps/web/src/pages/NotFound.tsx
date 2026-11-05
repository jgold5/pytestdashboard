import { Link } from 'react-router';
import { Compass } from 'lucide-react';
import { EmptyState } from '../components/ui/empty-state';
import { linkButton } from '../components/ui/link-button';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={<Compass />}
      title="Page not found"
      actions={
        <Link to="/" className={linkButton('outline')}>
          Back to overview
        </Link>
      }
    >
      The page you’re looking for doesn’t exist or was moved.
    </EmptyState>
  );
}
