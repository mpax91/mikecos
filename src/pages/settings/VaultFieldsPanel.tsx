import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { VAULT_FIELD_TYPES } from '../../api/types';
import type { VaultCategory, VaultFieldDef, VaultFieldGroup, VaultFieldType, VaultTemplate } from '../../api/types';
import { ConfirmModal } from '../../components/ConfirmModal';

type SubTab = 'fields' | 'groups' | 'templates' | 'categories';

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'fields', label: 'Fields' },
  { id: 'groups', label: 'Groups' },
  { id: 'templates', label: 'Templates' },
  { id: 'categories', label: 'Auto-categories' },
];

function FieldsSection({ fields, onChange }: { fields: VaultFieldDef[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<VaultFieldType>('text');
  const [deleting, setDeleting] = useState<VaultFieldDef | null>(null);

  async function add() {
    if (!name.trim()) return;
    await api.createVaultFieldDef(name.trim(), type);
    setName('');
    onChange();
  }

  return (
    <div>
      <p className="settings-subtext">
        The reusable library of field definitions — a name and a type. Fields don't do anything on their own; combine them into a Group below to actually
        use one.
      </p>
      <div className="vault-settings__list">
        {fields.map((f) => (
          <div key={f.id} className="vault-settings__row">
            <span>{f.name}</span>
            <span className="vault-settings__row-meta">{VAULT_FIELD_TYPES.find((t) => t.value === f.field_type)?.label}</span>
            <button className="btn btn--ghost btn--sm" onClick={() => setDeleting(f)}>
              Delete
            </button>
          </div>
        ))}
      </div>
      <div className="vault-settings__form-row">
        <input className="lock-screen__input" style={{ textAlign: 'left' }} placeholder="Field name (e.g. Serial Number)" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="lock-screen__input" style={{ textAlign: 'left' }} value={type} onChange={(e) => setType(e.target.value as VaultFieldType)}>
          {VAULT_FIELD_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button className="btn" onClick={add} disabled={!name.trim()}>
          Add field
        </button>
      </div>
      {deleting && (
        <ConfirmModal
          title="Delete this field?"
          body={`"${deleting.name}" will be removed from any groups that use it, and its values on existing entries will be lost.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await api.deleteVaultFieldDef(deleting.id);
            setDeleting(null);
            onChange();
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function GroupsSection({ groups, fields, onChange }: { groups: VaultFieldGroup[]; fields: VaultFieldDef[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<VaultFieldGroup | null>(null);

  async function add() {
    if (!name.trim() || selected.length === 0) return;
    await api.createVaultGroup(name.trim(), selected);
    setName('');
    setSelected([]);
    onChange();
  }

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div>
      <p className="settings-subtext">
        A named, reusable set of fields (e.g. "Login" = URL + Username + Password) — the unit you actually add to an entry, so the same shape stays
        consistent everywhere it's used.
      </p>
      <div className="vault-settings__list">
        {groups.map((g) => (
          <div key={g.id} className="vault-settings__row">
            <span>{g.name}</span>
            <span className="vault-settings__row-meta">{g.fields.map((f) => f.field_name).join(', ') || 'No fields'}</span>
            <button className="btn btn--ghost btn--sm" onClick={() => setDeleting(g)}>
              Delete
            </button>
          </div>
        ))}
      </div>
      <div className="vault-settings__form">
        <input className="lock-screen__input" style={{ textAlign: 'left' }} placeholder="Group name (e.g. Login)" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="vault-settings__checklist">
          {fields.map((f) => (
            <label key={f.id} className="vault-settings__checklist-item">
              <input type="checkbox" checked={selected.includes(f.id)} onChange={() => toggle(f.id)} />
              {f.name}
            </label>
          ))}
        </div>
        <button className="btn" onClick={add} disabled={!name.trim() || selected.length === 0}>
          Create group
        </button>
      </div>
      {deleting && (
        <ConfirmModal
          title="Delete this group?"
          body={`"${deleting.name}" will be removed. Entries that already have this group keep their values, but it can no longer be added to new entries.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await api.deleteVaultGroup(deleting.id);
            setDeleting(null);
            onChange();
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function TemplatesSection({ templates, groups, onChange }: { templates: VaultTemplate[]; groups: VaultFieldGroup[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<VaultTemplate | null>(null);

  async function add() {
    if (!name.trim()) return;
    await api.createVaultTemplate({ name: name.trim(), group_ids: selected });
    setName('');
    setSelected([]);
    onChange();
  }

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div>
      <p className="settings-subtext">
        A starter kit for a new entry — a name plus a preset set of groups. Pick one when creating a Vault entry so the same kind of note always starts
        with the same shape, instead of being rebuilt from scratch each time.
      </p>
      <div className="vault-settings__list">
        {templates.map((t) => (
          <div key={t.id} className="vault-settings__row">
            <span>{t.name}</span>
            <span className="vault-settings__row-meta">{t.groups.map((g) => g.name).join(', ') || 'No groups'}</span>
            <button className="btn btn--ghost btn--sm" onClick={() => setDeleting(t)}>
              Delete
            </button>
          </div>
        ))}
      </div>
      <div className="vault-settings__form">
        <input className="lock-screen__input" style={{ textAlign: 'left' }} placeholder="Template name (e.g. Credit Card)" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="vault-settings__checklist">
          {groups.map((g) => (
            <label key={g.id} className="vault-settings__checklist-item">
              <input type="checkbox" checked={selected.includes(g.id)} onChange={() => toggle(g.id)} />
              {g.name}
            </label>
          ))}
        </div>
        <button className="btn" onClick={add} disabled={!name.trim()}>
          Create template
        </button>
      </div>
      {deleting && (
        <ConfirmModal
          title="Delete this template?"
          body={`"${deleting.name}" will no longer be offered when creating a new entry. Entries already created from it are unaffected.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await api.deleteVaultTemplate(deleting.id);
            setDeleting(null);
            onChange();
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function CategoriesSection({ categories, fields, onChange }: { categories: VaultCategory[]; fields: VaultFieldDef[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('📁');
  const [fieldId, setFieldId] = useState('');
  const [deleting, setDeleting] = useState<VaultCategory | null>(null);

  async function add() {
    if (!name.trim() || !fieldId) return;
    await api.createVaultCategory(name.trim(), icon.trim() || '📁', fieldId);
    setName('');
    onChange();
  }

  return (
    <div>
      <p className="settings-subtext">
        Auto-categorization rules: any entry with a value in the trigger field automatically belongs to this category — no manual tagging. Once a category
        exists, it gets its own auto-populated tab on the Dashboard (coming next).
      </p>
      <div className="vault-settings__list">
        {categories.map((c) => (
          <div key={c.id} className="vault-settings__row">
            <span>
              {c.icon} {c.name}
            </span>
            <span className="vault-settings__row-meta">Triggered by: {fields.find((f) => f.id === c.trigger_field_def_id)?.name ?? 'Unknown field'}</span>
            <button className="btn btn--ghost btn--sm" onClick={() => setDeleting(c)}>
              Delete
            </button>
          </div>
        ))}
      </div>
      <div className="vault-settings__form-row">
        <input className="lock-screen__input" style={{ textAlign: 'left', width: 50 }} value={icon} onChange={(e) => setIcon(e.target.value)} />
        <input className="lock-screen__input" style={{ textAlign: 'left' }} placeholder="Category name (e.g. Inventory)" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="lock-screen__input" style={{ textAlign: 'left' }} value={fieldId} onChange={(e) => setFieldId(e.target.value)}>
          <option value="">Trigger field…</option>
          {fields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <button className="btn" onClick={add} disabled={!name.trim() || !fieldId}>
          Add rule
        </button>
      </div>
      {deleting && (
        <ConfirmModal
          title="Delete this category?"
          body={`"${deleting.name}" and its dashboard tab will be removed. Entries themselves are unaffected.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await api.deleteVaultCategory(deleting.id);
            setDeleting(null);
            onChange();
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/** Settings → Vault Fields: the grow-it-yourself library everything in
 * Vault entries is built from — field definitions, the groups they're
 * combined into, templates that preset a set of groups, and the rules
 * that auto-categorize an entry off which fields it has filled in. */
export function VaultFieldsPanel() {
  const [tab, setTab] = useState<SubTab>('fields');
  const [fields, setFields] = useState<VaultFieldDef[] | null>(null);
  const [groups, setGroups] = useState<VaultFieldGroup[] | null>(null);
  const [templates, setTemplates] = useState<VaultTemplate[] | null>(null);
  const [categories, setCategories] = useState<VaultCategory[] | null>(null);

  function loadAll() {
    api.listVaultFieldDefs().then(setFields);
    api.listVaultGroups().then(setGroups);
    api.listVaultTemplates().then(setTemplates);
    api.listVaultCategories().then(setCategories);
  }

  useEffect(() => {
    loadAll();
  }, []);

  if (!fields || !groups || !templates || !categories) return <div style={{ color: 'var(--color-muted)', fontSize: 13 }}>Loading…</div>;

  return (
    <div>
      <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>Vault Fields</h2>
      <div className="settings-subtabs">
        {SUB_TABS.map((t) => (
          <button key={t.id} className={`settings-subtab${tab === t.id ? ' is-active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'fields' && <FieldsSection fields={fields} onChange={loadAll} />}
      {tab === 'groups' && <GroupsSection groups={groups} fields={fields} onChange={loadAll} />}
      {tab === 'templates' && <TemplatesSection templates={templates} groups={groups} onChange={loadAll} />}
      {tab === 'categories' && <CategoriesSection categories={categories} fields={fields} onChange={loadAll} />}
    </div>
  );
}
