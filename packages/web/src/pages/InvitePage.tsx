import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, isAuthenticated } from '../lib/auth.js';

/** Landing page for an invite link: `/invite/<token>`. */
export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated()) {
      sessionStorage.setItem('agentmesh.pendingInvite', token);
      navigate('/login');
      return;
    }
    api()
      .acceptInvite(token)
      .then((detail) => navigate(`/s/${detail.session.id}`))
      .catch((caught: Error) => setError(caught.message));
  }, [token, navigate]);

  return (
    <div className="center-page">
      <div className="auth-card">
        <h1>Joining session</h1>
        {error ? <p className="sub">{error}</p> : <p className="sub">Redeeming your invite...</p>}
        {error && (
          <button className="primary" style={{ width: '100%' }} onClick={() => navigate('/')}>
            Back to sessions
          </button>
        )}
      </div>
    </div>
  );
}
