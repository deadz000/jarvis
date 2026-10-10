<#
屏幕图像探针（Windows / .NET）——仅用于「按需摘要」时物化一张缩小的图。

## 与 screen-probe.ps1 的分工
- screen-probe.ps1：每轮轮询都用，只回传紧凑数值（灰度/色块），**不产生图像**；
- 本脚本：只在攒批出批、需要模型摘要时调用一次，输出一张**降采样后的 JPEG**。

这样「图像」只在真正需要时才被物化，而不是每轮轮询都产生 ——
既降低隐私暴露面，也降低编码开销。

输出（单行 JSON）：{ ok, width, height, format, base64 }
失败时：{ ok:false, error:"..." } 并以退出码 1 结束。

注意：本文件必须保存为 **UTF-8 with BOM**，否则 Windows PowerShell 5.1
会按系统 ANSI 码页解码中文注释并可能静默吞掉语句（见 tests/unit/scripts-encoding.test.ts）。
#>
param(
  [int]$MaxWidth = 1024,
  [int]$JpegQuality = 60
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Drawing -ErrorAction Stop
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop

  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $full = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($full)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

  # 按比例缩到最大宽度以内（保持宽高比）
  if ($bounds.Width -gt $MaxWidth) {
    $targetWidth = $MaxWidth
    $targetHeight = [int][Math]::Round($bounds.Height * $MaxWidth / $bounds.Width)
  }
  else {
    $targetWidth = $bounds.Width
    $targetHeight = $bounds.Height
  }

  $scaled = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight)
  $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
  $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $scaledGraphics.DrawImage($full, 0, 0, $targetWidth, $targetHeight)

  # 编码为 JPEG（体积远小于 PNG，适合传给多模态模型）
  $stream = New-Object System.IO.MemoryStream
  $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
    [System.Drawing.Imaging.Encoder]::Quality, [int64]$JpegQuality)
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq 'image/jpeg' }
  $scaled.Save($stream, $codec, $encoderParams)

  $base64 = [Convert]::ToBase64String($stream.ToArray())

  $json = '{"ok":true' +
  ',"width":' + $targetWidth +
  ',"height":' + $targetHeight +
  ',"sourceWidth":' + $bounds.Width +
  ',"sourceHeight":' + $bounds.Height +
  ',"format":"jpeg"' +
  ',"byteLength":' + $stream.Length +
  ',"base64":"' + $base64 + '"' +
  '}'
  [Console]::Out.Write($json)

  $stream.Dispose()
  $graphics.Dispose()
  $scaledGraphics.Dispose()
  $full.Dispose()
  $scaled.Dispose()
}
catch {
  $message = $_.Exception.Message
  $message = $message -replace '\\', '\\'
  $message = $message -replace '"', '\"'
  $message = $message -replace "`r", ' '
  $message = $message -replace "`n", ' '
  [Console]::Out.Write('{"ok":false,"error":"' + $message + '"}')
  exit 1
}
