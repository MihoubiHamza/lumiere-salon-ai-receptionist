# Re-encodes an audio file to AAC in an MP4 container (.m4a) with Windows' built-in
# Media Foundation transcoder - the same container/codec family as Meta's voice clips.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File transcode-m4a.ps1 <in> <out.m4a>
# Optional: -Speak "<text>" writes <in> first with the local Windows English voice (SAPI, WAV).
param([Parameter(Mandatory = $true)][string]$In, [Parameter(Mandatory = $true)][string]$Out, [string]$Speak = '')
$ErrorActionPreference = 'Stop'
if ($Speak) {
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SetOutputToWaveFile($In)
  $s.Speak($Speak)
  $s.Dispose()
}
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$ext = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
$opT = ($ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$actProgT = ($ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncActionWithProgress`1' })[0]
function Wait-Op($op, [Type]$type) { $t = $opT.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Media.Transcoding.MediaTranscoder, Windows.Media.Transcoding, ContentType = WindowsRuntime]
[void][Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media.MediaProperties, ContentType = WindowsRuntime]
$inFile = Wait-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $In).Path)) ([Windows.Storage.StorageFile])
$outDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($Out))
$folder = Wait-Op ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($outDir)) ([Windows.Storage.StorageFolder])
$outFile = Wait-Op ($folder.CreateFileAsync((Split-Path -Leaf $Out), [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
$profile = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateM4a([Windows.Media.MediaProperties.AudioEncodingQuality]::Medium)
$tr = New-Object Windows.Media.Transcoding.MediaTranscoder
$prep = Wait-Op ($tr.PrepareFileTranscodeAsync($inFile, $outFile, $profile)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
if (-not $prep.CanTranscode) { throw ('cannot transcode: ' + $prep.FailureReason) }
$t = $actProgT.MakeGenericMethod([double]).Invoke($null, @($prep.TranscodeAsync()))
$t.Wait(-1) | Out-Null
Write-Output ('m4a written: ' + (Get-Item $Out).Length + ' bytes')
