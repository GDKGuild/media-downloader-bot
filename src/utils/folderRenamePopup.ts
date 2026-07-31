import { exec } from 'child_process';

export function showRenamePopup(message: string, logFilePath: string): void {
  // Escape single quotes and backslashes for PowerShell string embedding
  const escapedMessage = message
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/\n/g, '`n');

  const escapedLogPath = logFilePath.replace(/'/g, "''").replace(/\\/g, '\\\\');

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Folder Renames Detected'
$form.Size = New-Object System.Drawing.Size(520, 360)
$form.StartPosition = 'CenterScreen'
$form.MinimizeBox = $true
$form.MaximizeBox = $true
$form.FormBorderStyle = 'Sizable'
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = 'The following channel folders were renamed:'
$label.Location = New-Object System.Drawing.Point(12, 12)
$label.Size = New-Object System.Drawing.Size(480, 20)
$label.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.Controls.Add($label)

$textbox = New-Object System.Windows.Forms.TextBox
$textbox.Location = New-Object System.Drawing.Point(12, 36)
$textbox.Size = New-Object System.Drawing.Size(480, 230)
$textbox.Multiline = $true
$textbox.ReadOnly = $true
$textbox.ScrollBars = 'Vertical'
$textbox.Font = New-Object System.Drawing.Font('Consolas', 9)
$textbox.Text = '${escapedMessage}'
$form.Controls.Add($textbox)

$button = New-Object System.Windows.Forms.Button
$button.Text = 'Ok'
$button.Location = New-Object System.Drawing.Point(200, 278)
$button.Size = New-Object System.Drawing.Size(110, 32)
$button.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$button.Add_Click({
    Start-Process '${escapedLogPath}'
    $form.Close()
})
$form.Controls.Add($button)

$form.AcceptButton = $button
[void]$form.ShowDialog()
$form.Dispose()
`.trim();

  const child = exec(
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"')}"`,
    { windowsHide: true },
  );

  child.on('error', (err) => {
    console.error(`[Popup] Failed to show rename popup: ${err.message}`);
  });
}
