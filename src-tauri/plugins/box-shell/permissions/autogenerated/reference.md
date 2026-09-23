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
- `allow-setSecureMode`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
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

`box-shell:allow-setSecureMode`

</td>
<td>

Enables the setSecureMode command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`box-shell:deny-setSecureMode`

</td>
<td>

Denies the setSecureMode command without any pre-configured scope.

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
