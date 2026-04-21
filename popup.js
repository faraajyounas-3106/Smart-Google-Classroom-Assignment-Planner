let selectedItem = null;
let allAssignments = []; // Store for filtering and searching

document.addEventListener('DOMContentLoaded', function () {
  const fetchBtn = document.getElementById('fetchBtn');
  const planBtn = document.getElementById('generatePlanBtn');
  const explainBtn = document.getElementById('explainBtn');
  const modeSelector = document.getElementById('modeSelector');
  const listDiv = document.getElementById('assignmentList');
  const outputDiv = document.getElementById('output');
  const searchInput = document.getElementById('searchInput'); // New Search Input

  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdf.worker.min.js');
  }

  // --- HELPER FUNCTIONS ---

  function formatDueDate(dueDate) {
    if (!dueDate) return null;
    const { year, month, day } = dueDate;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function formatMarkdown(text) {
    return text
      .replace(/### (.*)/g, '<div class="plan-section"><strong>$1</strong></div>')
      .replace(/## (.*)/g, '<div class="plan-section"><strong>$1</strong></div>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^- (.*)/gm, '• $1<br>')
      .replace(/\n/g, '<br>');
  }

  // --- SEARCH LOGIC ---
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase();
      const filtered = allAssignments.filter(item => 
        item.courseName.toLowerCase().includes(term) || 
        item.title.toLowerCase().includes(term)
      );
      renderAssignments(filtered);
    });
  }

  // --- RENDERING ENGINE ---
  function renderAssignments(items) {
    listDiv.innerHTML = '';
    if (items.length === 0) {
      listDiv.innerHTML = '<div style="padding:15px;text-align:center;color:#64748b;">No matching assignments found.</div>';
      return;
    }

    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'assignment-item';
      if (selectedItem && selectedItem.id === item.id) div.classList.add('selected');

      const hasDeadline = !!item.dueDate;
      const deadlineStr = hasDeadline
        ? `<span style="color:#f87171;font-size:11px;">📅 Due: ${formatDueDate(item.dueDate)}</span>`
        : '<span style="color:#64748b;font-size:11px;">No deadline</span>';
      
      const attachCount = item.materials ? item.materials.length : 0;
      const attachStr = attachCount > 0 ? `<span style="color:#94a3b8;font-size:11px;"> · 📎 ${attachCount} file(s)</span>` : '';
      const typeTag = hasDeadline ? '<span class="type-tag">Task</span>' : '<span class="type-tag" style="background:#f59e0b">Note</span>';

      div.innerHTML = `<strong>${item.courseName}</strong><br>${item.title} ${typeTag}${attachStr}<br>${deadlineStr}`;
      
      div.onclick = () => {
        document.querySelectorAll('.assignment-item').forEach(el => el.classList.remove('selected'));
        div.classList.add('selected');
        selectedItem = item;
        modeSelector.style.display = 'flex';
      };
      listDiv.appendChild(div);
    });
  }

  // --- FILE EXTRACTION ENGINE ---
  async function extractContent(material, token) {
    if (material.youtubeVideo) return `[YouTube Video: "${material.youtubeVideo.title}" — ${material.youtubeVideo.alternateLink}]`;
    if (material.link) return `[External Link: "${material.link.title || 'untitled'}" — ${material.link.url}]`;
    if (material.form) return `[Google Form: "${material.form.title}" — ${material.form.formUrl}]`;
    if (!material.driveFile) return '';

    const fileId = material.driveFile.driveFile.id;
    const fileName = material.driveFile.driveFile.title;
    const mimeType = material.driveFile.driveFile.mimeType || '';
    const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';

    try {
      if (mimeType.includes('google-apps')) {
        let exportType = 'text/plain';
        if (mimeType.includes('spreadsheet')) exportType = 'text/csv';
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${exportType}`, { headers: { Authorization: `Bearer ${token}` } });
        return `[GOOGLE DOC/SHEET: ${fileName}]\n${await res.text()}`;
      }

      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) return `[ERROR: Could not download "${fileName}"]`;
      const arrayBuffer = await response.arrayBuffer();

      const textExts = ['txt','md','py','js','java','c','cpp','html','css','json','sql'];
      if (textExts.includes(ext)) return `[${ext.toUpperCase()} FILE: ${fileName}]\n${new TextDecoder().decode(arrayBuffer)}`;

      if (ext === 'pdf') {
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let text = '';
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map(s => s.str).join(' ') + '\n';
        }
        return `[PDF: ${fileName}]\n${text.trim()}`;
      }

      if (ext === 'docx') {
        const result = await mammoth.extractRawText({ arrayBuffer });
        return `[WORD: ${fileName}]\n${result.value}`;
      }

      return `[FILE: ${fileName}] (Content not extracted)`;
    } catch (err) { return `[ERROR reading "${fileName}"]: ${err.message}`; }
  }

  // --- FETCH ASSIGNMENTS ---
  fetchBtn.addEventListener('click', () => {
    chrome.identity.getAuthToken({ interactive: true }, async (token) => {
      if (chrome.runtime.lastError) {
        alert('Sign-in failed. Check OAuth Client ID.');
        return;
      }
      listDiv.innerHTML = '<div style="padding:10px;"><i class="fas fa-spinner fa-spin"></i> Scanning classes...</div>';
      
      try {
        const courseRes = await fetch('https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE', { headers: { Authorization: `Bearer ${token}` } });
        const { courses = [] } = await courseRes.json();
        
        allAssignments = [];
        const now = new Date();
        now.setHours(0, 0, 0, 0); // Start of today

        for (const course of courses) {
          const workRes = await fetch(`https://classroom.googleapis.com/v1/courses/${course.id}/courseWork`, { headers: { Authorization: `Bearer ${token}` } });
          const { courseWork = [] } = await workRes.json();
          
          courseWork.forEach(item => {
            // DEADLINE FILTERING: Skip if deadline was yesterday or earlier
            if (item.dueDate) {
              const due = new Date(item.dueDate.year, item.dueDate.month - 1, item.dueDate.day);
              if (due < now) return; 
            }
            allAssignments.push({ ...item, courseName: course.name });
          });
        }
        renderAssignments(allAssignments);
      } catch (err) {
        listDiv.innerHTML = '<div style="padding:10px;color:#f87171;">Error loading data.</div>';
      }
    });
  });

  // --- AI CALL ---
  async function callAI(mode) {
    outputDiv.innerHTML = '<i class="fas fa-microchip fa-spin"></i> Reading files...';
    chrome.identity.getAuthToken({ interactive: false }, async (token) => {
      let fileContext = '';
      const materials = selectedItem.materials || [];
      for (const m of materials) {
        const extracted = await extractContent(m, token);
        if (extracted) fileContext += extracted + '\n\n';
      }
      if (!fileContext.trim()) fileContext = '(No readable file attachments.)';

      const today = new Date().toISOString().split('T')[0];
      const GROQ_KEY = "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";

      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
              { role: 'system', content: mode === 'PLAN' ? `Action Coach mode. Today: ${today}. Create hourly plan.` : `Tutor mode. Explain notes step-by-step.` },
              { role: 'user', content: `Assignment: ${selectedItem.title}\nFILE CONTENT:\n${fileContext}` }
            ]
          })
        });
        const data = await res.json();
        outputDiv.innerHTML = formatMarkdown(data.choices[0].message.content);
      } catch (err) {
        outputDiv.innerHTML = '<span style="color:#f87171;">Request Failed.</span>';
      }
    });
  }

  planBtn.addEventListener('click', () => callAI('PLAN'));
  explainBtn.addEventListener('click', () => callAI('EXPLAIN'));
});