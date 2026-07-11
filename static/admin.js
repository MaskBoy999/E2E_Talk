let adminToken = null;

document.addEventListener('DOMContentLoaded', () => {
    // Check if already authenticated (stored in sessionStorage)
    if (sessionStorage.getItem('admin_auth')) {
        showPanel();
        loadUsers();
    }

    // Admin login form
    document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = document.getElementById('admin-password').value;

        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });

            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Wrong password');
                return;
            }

            sessionStorage.setItem('admin_auth', 'true');
            showPanel();
            loadUsers();
        } catch (err) {
            showError('Server is not running');
        }
    });

    // Modal controls
    document.getElementById('confirm-cancel').addEventListener('click', closeModal);
    document.getElementById('confirm-modal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('confirm-modal')) closeModal();
    });
});

function showError(msg) {
    const errDiv = document.getElementById('error-message');
    errDiv.textContent = msg;
    errDiv.style.display = 'block';
}

function showPanel() {
    document.getElementById('admin-login').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'block';
}

async function loadUsers() {
    const tbody = document.getElementById('user-list');

    try {
        const res = await fetch('/api/admin/users');
        const users = await res.json();

        if (!Array.isArray(users) || users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#666;">No users found</td></tr>';
            return;
        }

        tbody.innerHTML = '';

        users.forEach(user => {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escapeHtml(user.username) + '</td>' +
                '<td class="id-cell">' + escapeHtml(user.id) + '</td>' +
                '<td><button class="btn-delete-sm" onclick="openDeleteModal(\'' + user.id + '\', \'' + escapeHtml(user.username) + '\')">Delete</button></td>';
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#f44336;">Failed to load users</td></tr>';
    }
}

let pendingDeleteId = null;

function openDeleteModal(userId, username) {
    pendingDeleteId = userId;
    document.getElementById('delete-username').textContent = username;
    document.getElementById('confirm-modal').style.display = 'flex';
}

function closeModal() {
    pendingDeleteId = null;
    document.getElementById('confirm-modal').style.display = 'none';
}

document.getElementById('confirm-delete').addEventListener('click', async () => {
    if (!pendingDeleteId) return;

    const btn = document.getElementById('confirm-delete');
    btn.disabled = true;
    btn.textContent = 'Deleting...';

    try {
        const res = await fetch('/api/admin/users/' + pendingDeleteId, {
            method: 'DELETE'
        });

        if (!res.ok) {
            const data = await res.json();
            alert(data.error || 'Failed to delete user');
        }

        closeModal();
        loadUsers();
    } catch (err) {
        alert('Failed to delete user');
        closeModal();
    } finally {
        btn.disabled = false;
        btn.textContent = 'Delete';
    }
});

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
