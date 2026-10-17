const $ = id => document.getElementById(id);

function render(s) {
    if (!s) return;
    $('dot').classList.toggle('on', !!s.connected);
    $('status').textContent = s.connected
        ? `connected${s.capabilities ? ` · ${s.capabilities.length} capabilities` : ''}`
        : (s.error || 'not connected');
    if (s.server) $('server').value = s.server;
    if (Array.isArray(s.allowlist)) $('allowlist').value = s.allowlist.join('\n');
    if (typeof s.allowAll === 'boolean') $('allowall').checked = s.allowAll;
}

chrome.runtime.sendMessage({ nc: 'status' }, render);

$('connect').onclick = () => chrome.runtime.sendMessage({ nc: 'connect', server: $('server').value.trim() }, render);
$('disconnect').onclick = () => chrome.runtime.sendMessage({ nc: 'disconnect' }, render);

$('save').onclick = () => {
    const allowlist = $('allowlist').value.split('\n').map(l => l.trim()).filter(Boolean);
    chrome.runtime.sendMessage({ nc: 'setAccess', allowlist, allowAll: $('allowall').checked }, saved => {
        render(saved);
        // Say so out loud: a silent save on a security control leaves the user guessing
        // whether the thing they just restricted is actually restricted.
        $('saved').textContent = 'saved';
        setTimeout(() => { $('saved').textContent = ''; }, 1500);
    });
};
