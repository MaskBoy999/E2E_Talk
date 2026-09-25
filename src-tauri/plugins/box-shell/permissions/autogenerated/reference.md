## Default Permission

Full-screen shell behaviour on Android: hide the status and navigation bars
(revealed transiently by a swipe, for as long as the page asks to stay
immersive), route the hardware Back button to the page instead of closing the
app, and close the app when the page has nothing left to close.

Plus the device duties the WebView cannot perform for itself: buzz the phone's
real vibrator (`vibrate` — Chromium dropped the Vibration API on Android, so
`navigator.vibrate` is present and silently does nothing inside the app), and
dismiss every notification except an ongoing call's (`clearNotifications`).

Plus call comfort: keep the screen on for the length of a call
(`keepScreenOn`), and ask the system — once, in Android's own dialog — to
exempt the app from battery optimizations (`batteryStatus`/`batteryRequest`),
which is what stops Doze from quietly ending an ongoing call.

#### This default permission set includes the following:

- `allow-enterImmersive`
- `allow-exitImmersive`
- `allow-setBackHandler`
- `allow-exit`
- `allow-vibrate`
- `allow-clearNotifications`
- `allow-keepScreenOn`
- `allow-batteryStatus`
- `allow-batteryRequest`
- `allow-audioRoutes`
- `allow-setAudioRoute`
- `allow-sharedPending`
- `allow-sharedRead`
- `allow-sharedDiscard`
- `allow-captionsAvailable`
- `allow-captionsStart`
- `allow-captionsStop`
- `allow-copyFileToClipboard`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`box-shell:allow-audioRoutes`

</td>
<td>

Enables the audioRoutes command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-audioRoutes`

</td>
<td>

Denies the audioRoutes command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-batteryRequest`

</td>
<td>

Enables the batteryRequest command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-batteryRequest`

</td>
<td>

Denies the batteryRequest command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-batteryStatus`

</td>
<td>

Enables the batteryStatus command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-batteryStatus`

</td>
<td>

Denies the batteryStatus command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-captionsAvailable`

</td>
<td>

Enables the captionsAvailable command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-captionsAvailable`

</td>
<td>

Denies the captionsAvailable command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-captionsStart`

</td>
<td>

Enables the captionsStart command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-captionsStart`

</td>
<td>

Denies the captionsStart command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-captionsStop`

</td>
<td>

Enables the captionsStop command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-captionsStop`

</td>
<td>

Denies the captionsStop command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-clearNotifications`

</td>
<td>

Enables the clearNotifications command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-clearNotifications`

</td>
<td>

Denies the clearNotifications command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-copyFileToClipboard`

</td>
<td>

Enables the copyFileToClipboard command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-copyFileToClipboard`

</td>
<td>

Denies the copyFileToClipboard command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-enterImmersive`

</td>
<td>

Enables the enterImmersive command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-enterImmersive`

</td>
<td>

Denies the enterImmersive command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-exit`

</td>
<td>

Enables the exit command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-exit`

</td>
<td>

Denies the exit command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-exitImmersive`

</td>
<td>

Enables the exitImmersive command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-exitImmersive`

</td>
<td>

Denies the exitImmersive command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-keepScreenOn`

</td>
<td>

Enables the keepScreenOn command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-keepScreenOn`

</td>
<td>

Denies the keepScreenOn command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-setAudioRoute`

</td>
<td>

Enables the setAudioRoute command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-setAudioRoute`

</td>
<td>

Denies the setAudioRoute command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-setBackHandler`

</td>
<td>

Enables the setBackHandler command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-setBackHandler`

</td>
<td>

Denies the setBackHandler command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-sharedDiscard`

</td>
<td>

Enables the sharedDiscard command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-sharedDiscard`

</td>
<td>

Denies the sharedDiscard command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-sharedPending`

</td>
<td>

Enables the sharedPending command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-sharedPending`

</td>
<td>

Denies the sharedPending command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-sharedRead`

</td>
<td>

Enables the sharedRead command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-sharedRead`

</td>
<td>

Denies the sharedRead command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:allow-vibrate`

</td>
<td>

Enables the vibrate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-vibrate`

</td>
<td>

Denies the vibrate command without any pre-configured scope.

</td>
</tr>
</table>
