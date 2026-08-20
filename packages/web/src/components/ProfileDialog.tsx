import { AVATAR_COLORS, AVATAR_MAX_BYTES, AVATAR_MIME_TYPES, type User } from '@agentmesh/sdk';
import { useRef, useState } from 'react';
import { api, persistUser, storedUser } from '../lib/auth.js';
import { participantColor } from '../lib/colors.js';

/**
 * A person's own profile: their name, their colour and their picture.
 *
 * Colour is a choice rather than an assignment now, but still one of a fixed
 * nine: a free colour picker would let people choose something unreadable on
 * one of the two themes, or indistinguishable from a teammate.
 */
export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const initial = storedUser();
  const [user, setUser] = useState<User | null>(initial);
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  if (!user) return null;

  const apply = async (change: () => Promise<User>) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await change();
      setUser(updated);
      persistUser(updated);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    // Checked here as well as on the server, so the answer is immediate rather
    // than a round trip away.
    if (file.size > AVATAR_MAX_BYTES) {
      setError(`That image is ${Math.round(file.size / 1024)} KB. The limit is ${Math.round(AVATAR_MAX_BYTES / 1024)} KB.`);
      return;
    }
    await apply(() => api().uploadAvatar(file));
  };

  const palette = participantColor(user.avatarColor);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <strong>Your profile</strong>
          <button className="ghost" onClick={onClose}>
            close
          </button>
        </div>

        <div className="row" style={{ gap: 14, marginBottom: 16 }}>
          <div className="profile-preview" style={{ background: palette.tile }}>
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" />
            ) : (
              <span>{user.displayName.slice(0, 2).toUpperCase()}</span>
            )}
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <button disabled={busy} onClick={() => fileInput.current?.click()}>
              {user.avatarUrl ? 'Replace picture' : 'Upload picture'}
            </button>
            {user.avatarUrl && (
              <button className="ghost" disabled={busy} onClick={() => void apply(() => api().removeAvatar())}>
                Remove picture
              </button>
            )}
            <span className="sub" style={{ color: 'var(--text-dim)' }}>
              PNG, JPEG, WebP or GIF, up to {Math.round(AVATAR_MAX_BYTES / 1024)} KB
            </span>
          </div>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept={AVATAR_MIME_TYPES.join(',')}
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void upload(file);
          }}
        />

        <div className="field">
          <label htmlFor="display-name">Display name</label>
          <div className="row">
            <input
              id="display-name"
              value={displayName}
              disabled={busy}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <button
              disabled={busy || !displayName.trim() || displayName.trim() === user.displayName}
              onClick={() => void apply(() => api().updateProfile({ displayName: displayName.trim() }))}
            >
              Save
            </button>
          </div>
          <div className="sub" style={{ color: 'var(--text-dim)' }}>
            This is also your mention handle: @{displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}
          </div>
        </div>

        <div className="field">
          <label>Colour</label>
          <div className="swatches">
            {AVATAR_COLORS.map((name) => (
              <button
                key={name}
                type="button"
                title={name}
                aria-label={name}
                aria-pressed={user.avatarColor === name}
                className={`swatch${user.avatarColor === name ? ' selected' : ''}`}
                style={{ background: participantColor(name).tile }}
                disabled={busy}
                onClick={() => void apply(() => api().updateProfile({ avatarColor: name }))}
              />
            ))}
          </div>
        </div>

        {error && <div className="error-banner" style={{ margin: '8px 0 0' }}>{error}</div>}
      </div>
    </div>
  );
}
