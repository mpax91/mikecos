import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { BeeSocialConnection } from '../../api/types';
import { apiError } from '../../components/BeeMicrosoftSections';

/** Settings → Bedford Bee → Meta: App ID + secret, Connect, topic rules. */
export function MetaSettings() {
  const [conn, setConn] = useState<BeeSocialConnection | null>(null);
  const [rules, setRules] = useState<{ topic: string; keywords: string }[]>([]);
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [rulesText, setRulesText] = useState('');
  const [rulesMsg, setRulesMsg] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();

  const load = () =>
    api
      .getBeeSocial()
      .then((r) => {
        setConn(r.connection);
        if (!r.empty) setRules(r.topicRules);
        if (r.connection.appId) setAppId((a) => a || r.connection.appId!);
      })
      .catch(() => {});
  useEffect(() => {
    load();
    const err = params.get('metaError');
    if (err) setMsg(err);
    if (params.get('metaConnected')) {
      setMsg('Connected — pulling Facebook and Instagram history…');
      api
        .syncBeeMeta()
        .then((r) => setMsg(`Connected. Pulled ${r.fbPosts} Facebook and ${r.igPosts} Instagram posts.`))
        .catch((e) => setMsg(apiError(e)))
        .finally(load);
    }
    if (err || params.get('metaConnected')) {
      params.delete('metaError');
      params.delete('metaConnected');
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setRulesText(rules.map((r) => `${r.topic}: ${r.keywords}`).join('\n')), [rules]);

  async function saveApp() {
    setBusy(true);
    try {
      await api.setBeeMetaApp(appId, secret || null);
      setSecret('');
      setMsg('Saved. Now click Connect Meta.');
      load();
    } catch (e) {
      setMsg(apiError(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveRules() {
    const parsed = rulesText
      .split('\n')
      .map((l) => l.split(':'))
      .filter((p) => p.length >= 2)
      .map(([topic, ...rest]) => ({ topic: topic.trim(), keywords: rest.join(':').trim() }))
      .filter((r) => r.topic && r.keywords);
    const r = await api.setBeeTopicRules(parsed);
    setRules(r.rules);
    setRulesMsg(`Saved ${r.rules.length} topics — the Social tab uses them right away.`);
  }

  return (
    <>
      <h3 className="settings-page__field-label">Meta (Facebook + Instagram)</h3>
      {conn?.connected ? (
        <p>
          {conn.page}
          {conn.instagram ? ` · @${conn.instagram}` : ' · no Instagram linked'}
          {conn.userName ? <span className="settings-page__section-hint"> · signed in as {conn.userName}</span> : null}
          {conn.lastSyncAt && <span className="settings-page__section-hint"> · last full sync {new Date(conn.lastSyncAt).toLocaleString()}</span>}
        </p>
      ) : (
        <p className="settings-page__section-hint">
          From your Meta app (developers.facebook.com → MikeOS → App settings → Basic): paste the App ID and App Secret, save, then Connect Meta and sign in with the Facebook account that manages The Bedford
          Bee. On Meta’s screens, choose The Bedford Bee Page and its Instagram account.
        </p>
      )}
      <div className="toolbar-row bee-key-row">
        <input placeholder="App ID" value={appId} onChange={(e) => setAppId(e.target.value)} inputMode="numeric" />
        <input type="password" autoComplete="off" placeholder={conn?.hasApp ? 'App Secret (saved — paste to replace)' : 'App Secret'} value={secret} onChange={(e) => setSecret(e.target.value)} />
        <button className="btn btn--sm" onClick={saveApp} disabled={busy || !appId.trim() || (!secret.trim() && !conn?.hasApp)}>
          Save
        </button>
      </div>
      <div className="toolbar-row" style={{ justifyContent: 'flex-start', gap: 8 }}>
        <button className="btn btn--sm" onClick={() => api.connectBeeMeta()} disabled={!conn?.hasApp}>
          {conn?.connected ? 'Reconnect Meta' : 'Connect Meta'}
        </button>
        {conn?.connected && (
          <>
            <button
              className="btn btn--ghost btn--sm"
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.syncBeeMeta();
                  setMsg(`Pulled ${r.fbPosts} Facebook and ${r.igPosts} Instagram posts.`);
                } catch (e) {
                  setMsg(apiError(e));
                } finally {
                  setBusy(false);
                  load();
                }
              }}
              disabled={busy}
            >
              {busy ? 'Syncing…' : 'Sync Now'}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => api.disconnectBeeMeta().then(load)}>
              Disconnect
            </button>
          </>
        )}
      </div>
      {(msg || conn?.lastError) && <p className="settings-page__section-hint">{msg ?? conn?.lastError}</p>}

      {rules.length > 0 && (
        <>
          <h3 className="settings-page__field-label">Post Topics</h3>
          <p className="settings-page__section-hint">One topic per line — “Topic: keyword, keyword”. A post gets every topic whose keywords appear in its text. Used by Social → What Works and the post scorecards.</p>
          <textarea className="bee-rules" rows={Math.min(14, rules.length + 3)} value={rulesText} onChange={(e) => setRulesText(e.target.value)} />
          <div>
            <button className="btn btn--sm" onClick={saveRules}>
              Save Topics
            </button>
          </div>
          {rulesMsg && <p className="settings-page__section-hint">{rulesMsg}</p>}
        </>
      )}
    </>
  );
}
