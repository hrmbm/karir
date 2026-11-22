import { supabase, isConfigured } from './supabase.js?v=20261122-lowongan-v1';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js?v=20261122-lowongan-v1';
import { $, $$, esc } from './common.js?v=20261122-lowongan-v1';
import {
  DISTRICTS_BY_CITY,
  APPLY_INFO_SOURCES,
  FORM_INFO_SOURCES,
  QUESTION_TYPES,
  DEFAULT_VACANCIES,
  normalizeVacancy,
  normalizeVacancyList,
  extractActivePositionNames,
  mergeVacanciesWithPositions,
  normalizeDistrictToken,
  buildShareUrl
} from './vacancy-logic.js?v=20261122-lowongan-v1';

const loginView = $('#login-view');
const shell = $('#admin-shell');
const content = $('#admin-content');

let vacancies = [];
let currentAccessToken = '';
let searchQuery = '';
let editingVacancyId = null;
let draftVacancy = null;
let pickerCityFilter = 'Semua';
let pickerSearch = '';

const QUESTION_TYPE_LABELS = Object.fromEntries(QUESTION_TYPES.map(item => [item.value, item.label]));

function say(message) {
  let element = $('#admin-toast');
  if (!element) {
    element = document.createElement('div');
    element.id = 'admin-toast';
    element.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:1500;padding:12px 16px;background:#016172;color:#fff;border-radius:10px;font:13px Arial,Helvetica,sans-serif;box-shadow:0 8px 25px rgba(1,97,114,.22);max-width:min(460px,calc(100vw - 32px))';
    document.body.append(element);
  }
  element.textContent = message;
  element.classList.remove('hidden');
  clearTimeout(element._hideTimer);
  element._hideTimer = setTimeout(() => element.classList.add('hidden'), 3400);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

async function fetchVacancyData() {
  const [settingsResult, apiResult] = await Promise.all([
    supabase
      .from('portal_settings')
      .select('key,value')
      .in('key', ['job_vacancies_config', 'application_positions']),
    fetch('/api/vacancies', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
  ]);

  if (settingsResult.error) throw settingsResult.error;

  const settingsMap = Object.fromEntries((settingsResult.data || []).map(row => [row.key, row.value]));
  const supabaseConfig = Array.isArray(settingsMap.job_vacancies_config) ? settingsMap.job_vacancies_config : [];
  const positionNames = Array.isArray(settingsMap.application_positions) ? settingsMap.application_positions : [];
  const apiVacancies = Array.isArray(apiResult?.vacancies) ? apiResult.vacancies : [];

  let base = [];
  if (supabaseConfig.length) {
    base = supabaseConfig;
  } else if (apiResult?.customized === true && apiVacancies.length) {
    base = apiVacancies;
  } else if (positionNames.length) {
    base = [];
  } else if (apiVacancies.length) {
    base = apiVacancies;
  } else {
    base = DEFAULT_VACANCIES;
  }

  vacancies = mergeVacanciesWithPositions(base, positionNames);
}

async function persistVacancies(nextList) {
  const clean = normalizeVacancyList(nextList);
  if (!clean.length) {
    throw new Error('Minimal harus ada satu lowongan.');
  }
  const activeNames = extractActivePositionNames(clean);
  if (!activeNames.length) {
    throw new Error('Minimal satu lowongan harus berstatus Aktif agar halaman lamaran tetap tersedia.');
  }

  const now = new Date().toISOString();
  const { error: settingsError } = await supabase.from('portal_settings').upsert(
    [
      { key: 'application_positions', value: activeNames, updated_at: now },
      { key: 'job_vacancies_config', value: clean, updated_at: now }
    ],
    { onConflict: 'key' }
  );
  if (settingsError) throw settingsError;

  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token || currentAccessToken;
  if (token) {
    const response = await fetch('/api/vacancies', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ vacancies: clean })
    }).catch(() => null);
    if (response && !response.ok) {
      const errBody = await response.json().catch(() => ({}));
      console.warn('Sinkronisasi server lokal gagal:', errBody.error || response.status);
    }
  }

  vacancies = clean;
}

function formatDistrictSummary(districts = []) {
  if (!districts.length) return '<span class="loc-empty">Belum ditentukan</span>';
  const grouped = new Map();
  districts.forEach(token => {
    const parts = String(token).split(/\s*-\s*/);
    if (parts.length === 2) {
      const [city, dist] = parts;
      if (!grouped.has(city)) grouped.set(city, []);
      grouped.get(city).push(dist);
    } else {
      if (!grouped.has('Area')) grouped.set('Area', []);
      grouped.get('Area').push(token);
    }
  });
  return [...grouped.entries()]
    .map(([city, list]) => `<div><b>${esc(city)}:</b> ${esc(list.join(', '))}</div>`)
    .join('');
}

function formatQuestionSummary(questions = []) {
  if (!questions.length) return '<span class="loc-empty">Belum ada pertanyaan</span>';
  return `<ul class="q-summary-list">${questions
    .map((q, idx) => {
      const typeLabel = QUESTION_TYPE_LABELS[q.type] || q.type;
      let scoreSummary = '';
      if (q.options?.length) {
        scoreSummary = q.options
          .map(opt => `${opt.label} (${opt.score})`)
          .join(' · ');
      } else {
        scoreSummary = `Diisi (+${q.filledScore})`;
      }
      return `<li class="q-summary-item">
        <div class="q-summary-head">
          <span><b>${idx + 1}.</b> ${esc(q.label)}</span>
          <span class="q-summary-type">${esc(typeLabel)}</span>
        </div>
        <div class="q-summary-scores">${esc(scoreSummary)}</div>
      </li>`;
    })
    .join('')}</ul>`;
}

function filteredVacancies() {
  if (!searchQuery) return vacancies;
  return vacancies.filter(v => {
    const haystack = [
      v.name,
      v.primaryDistricts.join(' '),
      v.otherLocationLabel,
      ...v.questions.map(q => `${q.label} ${(q.options || []).map(o => o.label).join(' ')}`)
    ]
      .join(' ')
      .toLocaleLowerCase('id');
    return haystack.includes(searchQuery);
  });
}

function renderVacancyManager() {
  const list = filteredVacancies();
  const activeCount = vacancies.filter(v => v.active !== false).length;

  const desktopRows = list.length
    ? list
        .map(v => `<tr>
          <td>
            <div class="pos-name-title">${esc(v.name)}</div>
            <div class="pos-state-line ${v.active !== false ? '' : 'inactive'}">
              ${v.active !== false ? 'Aktif' : 'Nonaktif'}
            </div>
          </td>
          <td><div class="loc-district-list">${formatDistrictSummary(v.primaryDistricts)}</div></td>
          <td class="col-score">+${esc(v.primaryLocationScore)}</td>
          <td>${esc(v.otherLocationLabel)}</td>
          <td class="col-score">+${esc(v.otherLocationScore)}</td>
          <td>${formatQuestionSummary(v.questions)}</td>
          <td>
            <div class="vacancy-row-actions">
              <button type="button" class="icon-btn primary-action" data-edit-vacancy="${esc(v.id)}">Edit</button>
              <button type="button" class="icon-btn" data-share-vacancy="${esc(v.id)}">Bagikan</button>
              <button type="button" class="icon-btn" data-dup-vacancy="${esc(v.id)}">Duplikat</button>
              <button type="button" class="icon-btn danger-action" data-del-vacancy="${esc(v.id)}">Hapus</button>
            </div>
          </td>
        </tr>`)
        .join('')
    : `<tr><td colspan="7" class="table-empty">Tidak ada lowongan yang sesuai pencarian.</td></tr>`;

  const mobileCards = list.length
    ? list
        .map(v => `<article class="vacancy-card-m">
          <div class="vacancy-card-m-head">
            <div>
              <div class="pos-name-title">${esc(v.name)}</div>
              <div class="pos-state-line ${v.active !== false ? '' : 'inactive'}">
                ${v.active !== false ? 'Aktif' : 'Nonaktif'}
              </div>
            </div>
          </div>
          <div class="vacancy-card-m-grid">
            <div>
              <div class="vacancy-card-m-label">Lokasi Utama</div>
              <div class="loc-district-list">${formatDistrictSummary(v.primaryDistricts)}</div>
            </div>
            <div class="vacancy-card-m-score">+${esc(v.primaryLocationScore)}</div>
            <div>
              <div class="vacancy-card-m-label">Lokasi Lain</div>
              <div>${esc(v.otherLocationLabel)}</div>
            </div>
            <div class="vacancy-card-m-score">+${esc(v.otherLocationScore)}</div>
          </div>
          <div class="vacancy-card-m-qs">
            <div class="vacancy-card-m-label" style="margin-bottom:8px">Pertanyaan & Skor</div>
            ${formatQuestionSummary(v.questions)}
          </div>
          <div class="vacancy-card-m-actions">
            <button type="button" class="icon-btn primary-action" data-edit-vacancy="${esc(v.id)}">Edit</button>
            <button type="button" class="icon-btn" data-share-vacancy="${esc(v.id)}">Bagikan</button>
            <button type="button" class="icon-btn" data-dup-vacancy="${esc(v.id)}">Duplikat</button>
            <button type="button" class="icon-btn danger-action" data-del-vacancy="${esc(v.id)}">Hapus</button>
          </div>
        </article>`)
        .join('')
    : `<div class="vacancy-card-m"><div class="table-empty">Tidak ada lowongan yang sesuai pencarian.</div></div>`;

  content.innerHTML = `
    <div class="vacancy-toolbar">
      <div class="vacancy-toolbar-meta">
        <h2>Daftar Lowongan</h2>
        <span class="vacancy-count">${vacancies.length} posisi · ${activeCount} aktif</span>
      </div>
      <div class="vacancy-toolbar-actions">
        <input id="vacancy-search" class="vacancy-search" type="search" value="${esc(searchQuery)}" placeholder="Cari posisi, lokasi, pertanyaan…">
        <button id="share-portal-btn" type="button" class="btn btn-secondary">Bagikan Portal</button>
        <button id="add-vacancy-btn" type="button" class="btn btn-primary">+ Tambah Lowongan</button>
      </div>
    </div>

    <section class="vacancy-table-panel">
      <div class="vacancy-table-wrap">
        <table class="vacancy-table">
          <thead>
            <tr>
              <th class="col-pos">Nama Posisi</th>
              <th class="col-loc">Lokasi Utama</th>
              <th class="col-score">Skor</th>
              <th class="col-other">Lokasi Lain</th>
              <th class="col-score">Skor</th>
              <th class="col-questions">Pertanyaan & Skor</th>
              <th class="col-actions">Aksi</th>
            </tr>
          </thead>
          <tbody>${desktopRows}</tbody>
        </table>
      </div>
    </section>

    <section class="vacancy-cards-mobile">${mobileCards}</section>
  `;

  const searchInput = $('#vacancy-search');
  if (searchInput) {
    searchInput.addEventListener('input', event => {
      searchQuery = event.target.value.trim().toLocaleLowerCase('id');
      renderVacancyManager();
      const restored = $('#vacancy-search');
      if (restored) {
        restored.focus();
        restored.setSelectionRange(restored.value.length, restored.value.length);
      }
    });
  }

  $('#add-vacancy-btn')?.addEventListener('click', () => openVacancyEditor(null));
  $('#share-portal-btn')?.addEventListener('click', () => openShareModal(null));

  $$('[data-edit-vacancy]').forEach(btn =>
    btn.addEventListener('click', () => {
      const target = vacancies.find(item => item.id === btn.dataset.editVacancy);
      if (target) openVacancyEditor(target);
    })
  );

  $$('[data-share-vacancy]').forEach(btn =>
    btn.addEventListener('click', () => {
      const target = vacancies.find(item => item.id === btn.dataset.shareVacancy);
      if (target) openShareModal(target);
    })
  );

  $$('[data-dup-vacancy]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const source = vacancies.find(item => item.id === btn.dataset.dupVacancy);
      if (!source) return;
      let suffix = 2;
      let candidateName = `${source.name} (${suffix})`;
      while (vacancies.some(v => v.name.toLocaleLowerCase('id') === candidateName.toLocaleLowerCase('id'))) {
        suffix += 1;
        candidateName = `${source.name} (${suffix})`;
      }
      const cloned = normalizeVacancy(
        {
          ...structuredClone(source),
          id: '',
          name: candidateName
        },
        vacancies.length
      );
      try {
        await persistVacancies([...vacancies, cloned]);
        say(`Lowongan "${cloned.name}" ditambahkan.`);
        renderVacancyManager();
      } catch (error) {
        say(error.message || 'Gagal menduplikasi lowongan.');
      }
    })
  );

  $$('[data-del-vacancy]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const target = vacancies.find(item => item.id === btn.dataset.delVacancy);
      if (!target) return;
      if (vacancies.length <= 1) {
        say('Minimal satu lowongan harus dipertahankan.');
        return;
      }
      const remaining = vacancies.filter(v => v.id !== target.id);
      if (!extractActivePositionNames(remaining).length) {
        say('Tidak dapat menghapus karena harus ada minimal satu lowongan aktif.');
        return;
      }
      try {
        await persistVacancies(remaining);
        say(`Lowongan "${target.name}" dihapus.`);
        renderVacancyManager();
      } catch (error) {
        say(error.message || 'Lowongan gagal dihapus.');
      }
    })
  );
}

/* ==================== VACANCY EDITOR MODAL ==================== */

function ensureVacancyModal() {
  let modal = $('#vacancy-editor-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'vacancy-editor-modal';
  modal.className = 'modal-backdrop hidden';
  modal.innerHTML = `
    <section class="employee-modal-card vacancy-modal-card" role="dialog" aria-modal="true" aria-labelledby="vacancy-modal-title">
      <div class="employee-modal-head">
        <div>
          <small>PENGELOLA LOWONGAN</small>
          <h2 id="vacancy-modal-title">Edit Lowongan</h2>
        </div>
        <button type="button" class="modal-close" id="vacancy-modal-close" aria-label="Tutup">×</button>
      </div>
      <form id="vacancy-editor-form" class="vacancy-modal-form" novalidate>
        <div class="vacancy-modal-body">
          <div class="v-form-section">
            <div class="v-form-section-head"><h3>Posisi</h3></div>
            <div class="v-grid-2">
              <div class="v-field">
                <label for="v-name">Nama Posisi</label>
                <input id="v-name" class="input" type="text" maxlength="100" required placeholder="Contoh: Operator Spray">
              </div>
              <label class="v-check-inline" for="v-active">
                <input id="v-active" type="checkbox">
                <span>Aktif di /apply</span>
              </label>
            </div>
          </div>

          <div class="v-form-section">
            <div class="v-form-section-head"><h3>Lokasi & Skor</h3></div>
            <div class="v-grid-2" style="margin-bottom:14px">
              <div class="v-field">
                <label>Lokasi Utama (Kecamatan Prioritas)</label>
              </div>
              <div class="v-field">
                <label for="v-primary-score">Skor Lokasi Utama</label>
                <input id="v-primary-score" class="input" type="number" step="any">
              </div>
            </div>

            <div class="district-picker-controls">
              <select id="district-city-filter" class="select" aria-label="Filter kabupaten atau kota">
                <option value="Semua">Semua Wilayah</option>
                ${Object.keys(DISTRICTS_BY_CITY).map(city => `<option value="${esc(city)}">${esc(city)}</option>`).join('')}
              </select>
              <input id="district-search" class="input" type="search" placeholder="Cari kecamatan…">
              <button id="district-toggle-visible" type="button" class="btn btn-secondary">Pilih Semua</button>
            </div>
            <div id="district-picker-list" class="district-picker-list"></div>
            <div class="district-custom-row">
              <input id="district-custom-input" class="input" type="text" maxlength="80" placeholder="Tambah kecamatan / area lain…">
              <button id="district-custom-add" type="button" class="btn btn-secondary">Tambah</button>
            </div>
            <div id="district-selected-tags" class="district-selected-tags"></div>

            <div class="v-grid-2" style="margin-top:16px">
              <div class="v-field">
                <label for="v-other-label">Lokasi Lain (Area di luar lokasi utama)</label>
                <input id="v-other-label" class="input" type="text" maxlength="120" placeholder="Area selain lokasi utama">
              </div>
              <div class="v-field">
                <label for="v-other-score">Skor Lokasi Lain</label>
                <input id="v-other-score" class="input" type="number" step="any">
              </div>
            </div>
          </div>

          <div class="v-form-section">
            <div class="v-form-section-head">
              <h3>Pertanyaan & Skor</h3>
              <button id="add-question-btn" type="button" class="btn btn-secondary">+ Tambah Pertanyaan</button>
            </div>
            <div id="question-builder-list" class="q-builder-list"></div>
          </div>
        </div>

        <div class="vacancy-modal-footer">
          <div id="vacancy-editor-error" class="form-error" role="alert"></div>
          <div class="employee-modal-actions">
            <button type="button" class="btn btn-secondary" id="vacancy-modal-cancel">Batal</button>
            <button type="submit" class="btn btn-primary" id="vacancy-modal-save">Simpan Lowongan</button>
          </div>
        </div>
      </form>
    </section>
  `;
  document.body.append(modal);

  const close = () => {
    modal.classList.add('hidden');
    editingVacancyId = null;
    draftVacancy = null;
  };
  $('#vacancy-modal-close', modal).addEventListener('click', close);
  $('#vacancy-modal-cancel', modal).addEventListener('click', close);
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });

  $('#district-city-filter', modal).addEventListener('change', event => {
    pickerCityFilter = event.target.value;
    renderDistrictPicker();
  });
  $('#district-search', modal).addEventListener('input', event => {
    pickerSearch = event.target.value.trim().toLocaleLowerCase('id');
    renderDistrictPicker();
  });
  $('#district-toggle-visible', modal).addEventListener('click', () => {
    const visibleTokens = getVisibleDistrictTokens();
    if (!visibleTokens.length || !draftVacancy) return;
    const set = new Set(draftVacancy.primaryDistricts);
    const allSelected = visibleTokens.every(token => set.has(token));
    if (allSelected) {
      visibleTokens.forEach(token => set.delete(token));
    } else {
      visibleTokens.forEach(token => set.add(token));
    }
    draftVacancy.primaryDistricts = [...set];
    renderDistrictPicker();
  });
  $('#district-custom-add', modal).addEventListener('click', () => {
    const input = $('#district-custom-input', modal);
    const raw = input.value.trim();
    if (!raw || !draftVacancy) return;
    const token = pickerCityFilter !== 'Semua' && !raw.includes('-')
      ? normalizeDistrictToken(pickerCityFilter, raw)
      : raw;
    if (!draftVacancy.primaryDistricts.includes(token)) {
      draftVacancy.primaryDistricts.push(token);
    }
    input.value = '';
    renderDistrictPicker();
  });

  $('#add-question-btn', modal).addEventListener('click', () => {
    syncDraftFromEditorDom();
    draftVacancy.questions.push({
      id: `pertanyaan_${Date.now()}_${draftVacancy.questions.length + 1}`,
      label: '',
      type: 'dropdown',
      required: true,
      placeholder: '',
      filledScore: 0,
      options: [
        { label: 'Jawaban A', score: 10 },
        { label: 'Jawaban B', score: 0 }
      ]
    });
    renderQuestionBuilder();
  });

  $('#vacancy-editor-form', modal).addEventListener('submit', handleSaveVacancy);
  return modal;
}

function getVisibleDistrictTokens() {
  const tokens = [];
  for (const [city, list] of Object.entries(DISTRICTS_BY_CITY)) {
    if (pickerCityFilter !== 'Semua' && pickerCityFilter !== city) continue;
    for (const dist of list) {
      const token = normalizeDistrictToken(city, dist);
      if (!pickerSearch || token.toLocaleLowerCase('id').includes(pickerSearch)) {
        tokens.push(token);
      }
    }
  }
  return tokens;
}

function renderDistrictPicker() {
  if (!draftVacancy) return;
  const listHost = $('#district-picker-list');
  const tagsHost = $('#district-selected-tags');
  const toggleBtn = $('#district-toggle-visible');
  if (!listHost || !tagsHost) return;

  const selected = new Set(draftVacancy.primaryDistricts);
  const visible = getVisibleDistrictTokens();

  if (toggleBtn) {
    const allSelected = visible.length > 0 && visible.every(t => selected.has(t));
    toggleBtn.textContent = allSelected ? 'Kosongkan' : 'Pilih Semua';
  }

  listHost.innerHTML = visible.length
    ? visible
        .map(token => `<label class="district-chip">
          <input type="checkbox" value="${esc(token)}" ${selected.has(token) ? 'checked' : ''}>
          <span>${esc(token)}</span>
        </label>`)
        .join('')
    : '<div class="loc-empty">Kecamatan tidak ditemukan.</div>';

  $$('input[type="checkbox"]', listHost).forEach(cb =>
    cb.addEventListener('change', () => {
      if (!draftVacancy) return;
      const set = new Set(draftVacancy.primaryDistricts);
      if (cb.checked) set.add(cb.value);
      else set.delete(cb.value);
      draftVacancy.primaryDistricts = [...set];
      renderDistrictSelectedTags();
      if (toggleBtn) {
        const allSelected = visible.length > 0 && visible.every(t => set.has(t));
        toggleBtn.textContent = allSelected ? 'Kosongkan' : 'Pilih Semua';
      }
    })
  );

  renderDistrictSelectedTags();
}

function renderDistrictSelectedTags() {
  const tagsHost = $('#district-selected-tags');
  if (!tagsHost || !draftVacancy) return;
  tagsHost.innerHTML = draftVacancy.primaryDistricts.length
    ? draftVacancy.primaryDistricts
        .map(token => `<span class="district-selected-tag">${esc(token)} <button type="button" data-remove-district="${esc(token)}" aria-label="Hapus ${esc(token)}">×</button></span>`)
        .join('')
    : '<span class="loc-empty">Belum ada lokasi utama dipilih.</span>';

  $$('[data-remove-district]', tagsHost).forEach(btn =>
    btn.addEventListener('click', () => {
      const target = btn.dataset.removeDistrict;
      draftVacancy.primaryDistricts = draftVacancy.primaryDistricts.filter(item => item !== target);
      renderDistrictPicker();
    })
  );
}

function syncDraftFromEditorDom() {
  if (!draftVacancy) return;
  const modal = $('#vacancy-editor-modal');
  if (!modal) return;
  draftVacancy.name = $('#v-name', modal)?.value ?? draftVacancy.name;
  draftVacancy.active = $('#v-active', modal)?.checked ?? draftVacancy.active;
  draftVacancy.primaryLocationScore = Number($('#v-primary-score', modal)?.value ?? 0);
  draftVacancy.otherLocationLabel = $('#v-other-label', modal)?.value ?? 'Area selain lokasi utama';
  draftVacancy.otherLocationScore = Number($('#v-other-score', modal)?.value ?? 0);

  const cards = $$('.q-builder-item', modal);
  draftVacancy.questions = cards.map((card, idx) => {
    const existing = draftVacancy.questions[idx] || {};
    const type = $('[data-q-field="type"]', card)?.value || existing.type || 'text';
    const label = $('[data-q-field="label"]', card)?.value ?? existing.label ?? '';
    const required = $('[data-q-field="required"]', card)?.checked ?? true;
    const hasOptions = type === 'dropdown' || type === 'radio' || type === 'checkbox';

    let options = existing.options || [];
    if (hasOptions) {
      const optRows = $$('.q-option-row', card);
      if (optRows.length) {
        options = optRows.map(row => ({
          label: $('[data-opt-label]', row)?.value ?? '',
          score: Number($('[data-opt-score]', row)?.value ?? 0)
        }));
      } else if (!options.length) {
        options = [
          { label: 'Jawaban A', score: 10 },
          { label: 'Jawaban B', score: 0 }
        ];
      }
    }

    return {
      id: existing.id || '',
      label,
      type,
      required,
      placeholder: $('[data-q-field="placeholder"]', card)?.value ?? existing.placeholder ?? '',
      filledScore: hasOptions ? 0 : Number($('[data-q-field="filledScore"]', card)?.value ?? existing.filledScore ?? 0),
      options: hasOptions ? options : []
    };
  });
}

function renderQuestionBuilder() {
  const host = $('#question-builder-list');
  if (!host || !draftVacancy) return;

  if (!draftVacancy.questions.length) {
    host.innerHTML = '<div class="loc-empty">Belum ada pertanyaan. Klik "+ Tambah Pertanyaan" untuk menambahkan.</div>';
    return;
  }

  host.innerHTML = draftVacancy.questions
    .map((q, qIdx) => {
      const hasOptions = q.type === 'dropdown' || q.type === 'radio' || q.type === 'checkbox';
      const optionsHtml = hasOptions
        ? `<div class="q-options-box">
            <div class="q-options-head"><span>Pilihan Jawaban</span><span>Skor</span><span></span></div>
            ${(q.options || [])
              .map(
                (opt, optIdx) => `<div class="q-option-row" data-opt-idx="${optIdx}">
                  <input class="input" type="text" data-opt-label value="${esc(opt.label)}" placeholder="Teks jawaban">
                  <input class="input" type="number" step="any" data-opt-score value="${esc(opt.score ?? 0)}" aria-label="Skor jawaban">
                  <button type="button" class="q-option-del" data-del-opt="${qIdx}:${optIdx}" title="Hapus jawaban" ${(q.options || []).length <= 1 ? 'disabled' : ''}>×</button>
                </div>`
              )
              .join('')}
            <button type="button" class="icon-btn" data-add-opt="${qIdx}" style="margin-top:4px">+ Tambah Jawaban</button>
          </div>`
        : `<div class="q-nonoption-box">
            <div class="v-field">
              <label>Placeholder</label>
              <input class="input" type="text" data-q-field="placeholder" value="${esc(q.placeholder || '')}" placeholder="Contoh jawaban singkat">
            </div>
            <div class="v-field">
              <label>Skor jika diisi</label>
              <input class="input" type="number" step="any" data-q-field="filledScore" value="${esc(q.filledScore ?? 0)}">
            </div>
          </div>`;

      return `<div class="q-builder-item" data-q-idx="${qIdx}">
        <div class="q-builder-top">
          <span class="q-builder-index">Pertanyaan ${qIdx + 1}</span>
          <div class="q-builder-controls">
            <button type="button" class="icon-btn" data-move-q="${qIdx}:-1" ${qIdx === 0 ? 'disabled' : ''} title="Naik">↑</button>
            <button type="button" class="icon-btn" data-move-q="${qIdx}:1" ${qIdx === draftVacancy.questions.length - 1 ? 'disabled' : ''} title="Turun">↓</button>
            <button type="button" class="icon-btn danger-action" data-del-q="${qIdx}">Hapus</button>
          </div>
        </div>
        <div class="q-builder-fields">
          <div class="v-field">
            <label>Pertanyaan</label>
            <input class="input" type="text" data-q-field="label" value="${esc(q.label)}" placeholder="Tulis pertanyaan untuk kandidat">
          </div>
          <div class="v-field">
            <label>Tipe Input</label>
            <select class="select" data-q-field="type">
              ${QUESTION_TYPES.map(t => `<option value="${esc(t.value)}" ${q.type === t.value ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
            </select>
          </div>
          <label class="v-check-inline">
            <input type="checkbox" data-q-field="required" ${q.required !== false ? 'checked' : ''}>
            <span>Wajib</span>
          </label>
        </div>
        ${optionsHtml}
      </div>`;
    })
    .join('');

  $$('[data-q-field="type"]', host).forEach(select =>
    select.addEventListener('change', () => {
      syncDraftFromEditorDom();
      renderQuestionBuilder();
    })
  );

  $$('[data-move-q]', host).forEach(btn =>
    btn.addEventListener('click', () => {
      syncDraftFromEditorDom();
      const [idxStr, deltaStr] = btn.dataset.moveQ.split(':');
      const idx = Number(idxStr);
      const targetIdx = idx + Number(deltaStr);
      if (targetIdx < 0 || targetIdx >= draftVacancy.questions.length) return;
      const [moved] = draftVacancy.questions.splice(idx, 1);
      draftVacancy.questions.splice(targetIdx, 0, moved);
      renderQuestionBuilder();
    })
  );

  $$('[data-del-q]', host).forEach(btn =>
    btn.addEventListener('click', () => {
      syncDraftFromEditorDom();
      const idx = Number(btn.dataset.delQ);
      draftVacancy.questions.splice(idx, 1);
      renderQuestionBuilder();
    })
  );

  $$('[data-add-opt]', host).forEach(btn =>
    btn.addEventListener('click', () => {
      syncDraftFromEditorDom();
      const idx = Number(btn.dataset.addOpt);
      const q = draftVacancy.questions[idx];
      if (!q) return;
      q.options = q.options || [];
      const letter = String.fromCharCode(65 + (q.options.length % 26));
      q.options.push({ label: `Jawaban ${letter}`, score: 0 });
      renderQuestionBuilder();
    })
  );

  $$('[data-del-opt]', host).forEach(btn =>
    btn.addEventListener('click', () => {
      syncDraftFromEditorDom();
      const [qIdx, optIdx] = btn.dataset.delOpt.split(':').map(Number);
      const q = draftVacancy.questions[qIdx];
      if (!q || !Array.isArray(q.options) || q.options.length <= 1) return;
      q.options.splice(optIdx, 1);
      renderQuestionBuilder();
    })
  );
}

function openVacancyEditor(vacancy = null) {
  const modal = ensureVacancyModal();
  editingVacancyId = vacancy?.id || null;
  pickerCityFilter = 'Semua';
  pickerSearch = '';

  draftVacancy = vacancy
    ? structuredClone(vacancy)
    : {
        id: '',
        name: '',
        active: true,
        primaryDistricts: ['Pasuruan - Purwosari', 'Pasuruan - Purwodadi', 'Pasuruan - Sukorejo', 'Pasuruan - Pandaan', 'Pasuruan - Prigen'],
        primaryLocationScore: 10,
        otherLocationLabel: 'Area selain lokasi utama',
        otherLocationScore: 5,
        questions: [
          {
            id: 'pengalaman_utama',
            label: 'Berapa lama pengalaman di bidang ini?',
            type: 'dropdown',
            required: true,
            placeholder: '',
            filledScore: 0,
            options: [
              { label: 'Lebih dari 6 bulan', score: 15 },
              { label: 'Kurang dari 6 bulan', score: 5 }
            ]
          },
          {
            id: 'penjelasan',
            label: 'Jelaskan pengalaman kerja sebelumnya',
            type: 'textarea',
            required: true,
            placeholder: 'Perusahaan, tugas, dan keahlian',
            filledScore: 5,
            options: []
          }
        ]
      };

  $('#vacancy-modal-title', modal).textContent = vacancy ? `Edit · ${vacancy.name}` : 'Tambah Lowongan Baru';
  $('#v-name', modal).value = draftVacancy.name || '';
  $('#v-active', modal).checked = draftVacancy.active !== false;
  $('#v-primary-score', modal).value = String(draftVacancy.primaryLocationScore ?? 0);
  $('#v-other-label', modal).value = draftVacancy.otherLocationLabel || 'Area selain lokasi utama';
  $('#v-other-score', modal).value = String(draftVacancy.otherLocationScore ?? 0);
  $('#district-city-filter', modal).value = 'Semua';
  $('#district-search', modal).value = '';
  $('#district-custom-input', modal).value = '';
  $('#vacancy-editor-error', modal).textContent = '';

  renderDistrictPicker();
  renderQuestionBuilder();

  modal.classList.remove('hidden');
  $('#v-name', modal).focus();
}

async function handleSaveVacancy(event) {
  event.preventDefault();
  if (!draftVacancy) return;
  const modal = $('#vacancy-editor-modal');
  const errorBox = $('#vacancy-editor-error', modal);
  const saveBtn = $('#vacancy-modal-save', modal);
  errorBox.textContent = '';

  syncDraftFromEditorDom();

  const cleanName = String(draftVacancy.name || '').trim();
  if (!cleanName) {
    errorBox.textContent = 'Nama posisi wajib diisi.';
    $('#v-name', modal)?.focus();
    return;
  }

  const duplicate = vacancies.some(
    v => v.id !== editingVacancyId && v.name.toLocaleLowerCase('id') === cleanName.toLocaleLowerCase('id')
  );
  if (duplicate) {
    errorBox.textContent = 'Nama posisi sudah digunakan lowongan lain.';
    return;
  }

  for (let i = 0; i < draftVacancy.questions.length; i++) {
    const q = draftVacancy.questions[i];
    if (!String(q.label || '').trim()) {
      errorBox.textContent = `Teks Pertanyaan ${i + 1} belum diisi.`;
      return;
    }
    if (['dropdown', 'radio', 'checkbox'].includes(q.type)) {
      const validOpts = (q.options || []).filter(o => String(o.label || '').trim());
      if (!validOpts.length) {
        errorBox.textContent = `Pertanyaan ${i + 1} memerlukan minimal satu pilihan jawaban.`;
        return;
      }
    }
  }

  const normalized = normalizeVacancy(
    {
      ...draftVacancy,
      id: editingVacancyId || ''
    },
    vacancies.length
  );

  const nextList = editingVacancyId
    ? vacancies.map(v => (v.id === editingVacancyId ? normalized : v))
    : [...vacancies, normalized];

  saveBtn.disabled = true;
  saveBtn.textContent = 'Menyimpan…';
  try {
    await persistVacancies(nextList);
    modal.classList.add('hidden');
    editingVacancyId = null;
    draftVacancy = null;
    say(`Lowongan "${normalized.name}" disimpan.`);
    renderVacancyManager();
  } catch (error) {
    errorBox.textContent = error.message || 'Gagal menyimpan lowongan.';
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Simpan Lowongan';
  }
}

/* ==================== SHARE LINK MODAL ==================== */

function ensureShareModal() {
  let modal = $('#share-vacancy-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'share-vacancy-modal';
  modal.className = 'modal-backdrop hidden';
  modal.innerHTML = `
    <section class="employee-modal-card vacancy-modal-card share-modal-card" role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
      <div class="employee-modal-head">
        <div>
          <small>SEBAR LOWONGAN</small>
          <h2 id="share-modal-title">Bagikan Link Lamaran</h2>
        </div>
        <button type="button" class="modal-close" id="share-modal-close" aria-label="Tutup">×</button>
      </div>
      <div class="vacancy-modal-body">
        <div class="v-grid-eq">
          <div class="v-field">
            <label for="share-position">Lowongan / Posisi</label>
            <select id="share-position" class="select"></select>
          </div>
          <div class="v-field">
            <label for="share-source">Tag Sumber Informasi</label>
            <select id="share-source" class="select"></select>
          </div>
        </div>

        <div class="v-form-section">
          <div class="v-form-section-head"><h3>Link Tahap 1 (/apply)</h3></div>
          <div id="share-apply-url" class="share-preview-box"></div>
          <div class="share-actions-row">
            <button type="button" class="btn btn-primary" id="copy-apply-url">Salin Link /apply</button>
            <a id="open-apply-url" class="btn btn-secondary" target="_blank" rel="noopener noreferrer">Buka /apply ↗</a>
          </div>
        </div>

        <div class="v-form-section">
          <div class="v-form-section-head"><h3>Link Formulir Lengkap (/form)</h3></div>
          <div id="share-form-url" class="share-preview-box"></div>
          <div class="share-actions-row">
            <button type="button" class="btn btn-secondary" id="copy-form-url">Salin Link /form</button>
            <a id="open-form-url" class="btn btn-secondary" target="_blank" rel="noopener noreferrer">Buka /form ↗</a>
          </div>
        </div>
      </div>
    </section>
  `;
  document.body.append(modal);

  const close = () => modal.classList.add('hidden');
  $('#share-modal-close', modal).addEventListener('click', close);
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });

  const updateUrls = () => {
    const position = $('#share-position', modal).value;
    const source = $('#share-source', modal).value;
    const applySource = APPLY_INFO_SOURCES.includes(source) ? source : '';
    const applyHref = buildShareUrl(new URL('apply/', location.href).href, position, applySource);
    const formHref = buildShareUrl(new URL('form/', location.href).href, position, source);
    $('#share-apply-url', modal).textContent = applyHref;
    $('#open-apply-url', modal).href = applyHref;
    $('#share-form-url', modal).textContent = formHref;
    $('#open-form-url', modal).href = formHref;
  };

  $('#share-position', modal).addEventListener('change', updateUrls);
  $('#share-source', modal).addEventListener('change', updateUrls);

  $('#copy-apply-url', modal).addEventListener('click', async () => {
    const url = $('#share-apply-url', modal).textContent;
    await copyText(url);
    say('Link /apply berhasil disalin.');
  });
  $('#copy-form-url', modal).addEventListener('click', async () => {
    const url = $('#share-form-url', modal).textContent;
    await copyText(url);
    say('Link /form berhasil disalin.');
  });

  modal._updateUrls = updateUrls;
  return modal;
}

function openShareModal(vacancy = null) {
  const modal = ensureShareModal();
  const activeVacancies = vacancies.filter(v => v.active !== false);
  const posSelect = $('#share-position', modal);
  const srcSelect = $('#share-source', modal);

  posSelect.innerHTML =
    '<option value="">Semua Lowongan</option>' +
    activeVacancies.map(v => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('');
  posSelect.value = vacancy && vacancy.active !== false ? vacancy.name : '';

  srcSelect.innerHTML =
    '<option value="">Tanpa tag sumber</option>' +
    FORM_INFO_SOURCES.map(src => `<option value="${esc(src)}">${esc(src)}</option>`).join('');
  srcSelect.value = '';

  modal._updateUrls();
  modal.classList.remove('hidden');
}

/* ==================== LIGHTWEIGHT AUTH & BOOT ==================== */

async function openAdmin(session) {
  const { data: isAdmin, error } = await supabase.rpc('is_portal_admin');
  if (error || !isAdmin) {
    await supabase.auth.signOut();
    throw new Error('Akses admin tidak valid atau belum aktif.');
  }

  currentAccessToken = session.access_token || '';
  const { data: profile } = await supabase
    .from('admin_users')
    .select('display_name')
    .eq('user_id', session.user.id)
    .maybeSingle();

  $('#admin-name').textContent = profile?.display_name || session.user.email || 'HR Admin';
  loginView.classList.add('hidden');
  shell.classList.remove('hidden');

  content.innerHTML = '<div class="vacancy-card-m"><div class="table-empty">Memuat daftar lowongan…</div></div>';
  try {
    await fetchVacancyData();
    renderVacancyManager();
  } catch (loadError) {
    content.innerHTML = `<div class="vacancy-card-m">
      <div class="table-empty">${esc(loadError.message || 'Gagal memuat daftar lowongan.')}</div>
      <div style="text-align:center;margin-top:12px">
        <button id="retry-vacancies" class="btn btn-secondary" type="button">Muat Ulang</button>
      </div>
    </div>`;
    $('#retry-vacancies')?.addEventListener('click', () => openAdmin(session));
  }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const user = $('#login-user').value.trim().toLowerCase();
  const pin = $('#login-pin').value.trim();
  const errorBox = $('#login-error');
  const button = event.currentTarget.querySelector('button[type="submit"]');
  errorBox.textContent = '';

  if (!isConfigured) {
    errorBox.textContent = 'Konfigurasi Supabase belum diisi.';
    return;
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(user)) {
    errorBox.textContent = 'Username 3–32 karakter (huruf kecil, angka, titik, _ atau -).';
    return;
  }
  if (!/^\d{4,12}$/.test(pin)) {
    errorBox.textContent = 'PIN harus 4–12 angka.';
    return;
  }

  button.disabled = true;
  button.textContent = 'Memeriksa…';
  try {
    const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/admin-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_PUBLISHABLE_KEY
      },
      body: JSON.stringify({ username: user, pin })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.session?.access_token || !result.session?.refresh_token) {
      throw new Error(result.error || 'Username atau PIN tidak sesuai.');
    }

    const { data, error } = await supabase.auth.setSession({
      access_token: result.session.access_token,
      refresh_token: result.session.refresh_token
    });
    if (error) throw error;
    await openAdmin(data.session);
    $('#login-pin').value = '';
  } catch (error) {
    errorBox.textContent = error.message || 'Login gagal.';
    button.disabled = false;
    button.textContent = 'Masuk';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await supabase?.auth.signOut();
  shell.classList.add('hidden');
  loginView.classList.remove('hidden');
  $('#login-pin').value = '';
  currentAccessToken = '';
  const loginButton = $('#login-form button[type="submit"]');
  if (loginButton) {
    loginButton.disabled = false;
    loginButton.textContent = 'Masuk';
  }
});

async function init() {
  if (!isConfigured) {
    $('#login-error').textContent = 'Konfigurasi Supabase belum diisi.';
    return;
  }
  const {
    data: { session }
  } = await supabase.auth.getSession();
  if (session) {
    try {
      await openAdmin(session);
    } catch (error) {
      $('#login-error').textContent = error.message;
    }
  }
}

init();
