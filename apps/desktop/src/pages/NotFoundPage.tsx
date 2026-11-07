import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui';

export function NotFoundPage() {
  return (
    <EmptyState
      title="Página não encontrada"
      description="A rota informada não existe na interface."
      action={
        <Link to="/" className="text-sm text-emerald-400 hover:underline">
          Voltar ao dashboard
        </Link>
      }
    />
  );
}
