try {
    $connections = netstat -ano | Select-String ":3443"
    if ($connections) {
        $connections | ForEach-Object {
            $parts = $_ -split '\s+'
            $procId = $parts[-1]
            Write-Host "Killing PID: $procId"
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep 3
    $remaining = netstat -ano | Select-String ":3443"
    if ($remaining) {
        Write-Host "Port still in use:"
        $remaining | Write-Host
    } else {
        Write-Host "Port 3443 is now free"
    }
} catch {
    Write-Host "Error: $_"
}
