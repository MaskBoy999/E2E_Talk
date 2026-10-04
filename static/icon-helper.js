/* icon(name, size) — returns inline SVG referencing the inlined sprite.
   Usage: icon('camera') → <svg class="ui-icon" width="16" height="16"><use href="#icon-camera"/></svg>
   This lived as an inline <script> in index.html and admin.html; it is an
   external file so the server's Content-Security-Policy no longer needs
   'unsafe-inline' for scripts. */
function icon(name, size) {
    return '<svg class="ui-icon" width="' + (size || 16) + '" height="' + (size || 16) + '" aria-hidden="true"><use href="#icon-' + name + '"/></svg>';
}
