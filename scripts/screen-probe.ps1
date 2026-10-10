<#
屏幕采集探针（Windows / .NET）。

## 为什么把降采样放在这里
隐私与成本要求「帧不落盘」。更强的做法是**让帧连 Node 的堆都不进**：
本脚本在 .NET 里完成「截屏 → 降采样」，只把紧凑的数值数组写到 stdout。
决策逻辑（哈希、双条件过滤、节流）全部留在 TypeScript 里，便于确定性单测。

输出（单行紧凑 JSON）：
{ ok, width, height, capturedAtMs, hashSize, blockSize, gray: [64], rgb: [768] }

- gray：8x8 灰度（用于 64 位中值指纹）
- rgb：16x16 色块均值 RGB（用于大面积色块变化检测）

失败时输出 { ok:false, error:"..." } 并以退出码 1 结束。
#>
param(
  [int]$HashSize = 8,
  [int]$Blocks = 16
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Drawing -ErrorAction Stop
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop

  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $full = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($full)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

  # --- 8x8 灰度：64 位中值指纹的输入 ---
  $gray = New-Object System.Drawing.Bitmap($HashSize, $HashSize)
  $grayGraphics = [System.Drawing.Graphics]::FromImage($gray)
  $grayGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $grayGraphics.DrawImage($full, 0, 0, $HashSize, $HashSize)

  $grayValues = New-Object 'System.Int32[]' ($HashSize * $HashSize)
  for ($y = 0; $y -lt $HashSize; $y++) {
    for ($x = 0; $x -lt $HashSize; $x++) {
      $pixel = $gray.GetPixel($x, $y)
      $luma = 0.299 * $pixel.R + 0.587 * $pixel.G + 0.114 * $pixel.B
      $grayValues[$y * $HashSize + $x] = [int][Math]::Round($luma)
    }
  }

  # --- 16x16 色块均值：大面积色块变化检测的输入 ---
  $small = New-Object System.Drawing.Bitmap($Blocks, $Blocks)
  $smallGraphics = [System.Drawing.Graphics]::FromImage($small)
  $smallGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $smallGraphics.DrawImage($full, 0, 0, $Blocks, $Blocks)

  $rgb = New-Object 'System.Int32[]' ($Blocks * $Blocks * 3)
  for ($y = 0; $y -lt $Blocks; $y++) {
    for ($x = 0; $x -lt $Blocks; $x++) {
      $pixel = $small.GetPixel($x, $y)
      $index = ($y * $Blocks + $x) * 3
      $rgb[$index] = $pixel.R
      $rgb[$index + 1] = $pixel.G
      $rgb[$index + 2] = $pixel.B
    }
  }

  # --- 手工构造 JSON ---
  # 不能用 ConvertTo-Json：Windows PowerShell 5.1 会把数组序列化成
  # {"value":[...],"Count":N} 而不是 [...]，导致消费端解析不到数组。
  # 手工拼接反而更可控，且避免了序列化器在不同 PS 版本下的行为差异。
  $grayJson = '[' + ($grayValues -join ',') + ']'
  $rgbJson = '[' + ($rgb -join ',') + ']'
  $capturedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  $json = '{"ok":true' +
  ',"width":' + $bounds.Width +
  ',"height":' + $bounds.Height +
  ',"capturedAtMs":' + $capturedAtMs +
  ',"hashSize":' + $HashSize +
  ',"blockSize":' + $Blocks +
  ',"gray":' + $grayJson +
  ',"rgb":' + $rgbJson +
  '}'

  [Console]::Out.Write($json)

  $graphics.Dispose()
  $grayGraphics.Dispose()
  $smallGraphics.Dispose()
  $full.Dispose()
  $gray.Dispose()
  $small.Dispose()
}
catch {
  # 同样手工构造，避免序列化器差异；转义反斜杠与引号，压掉换行
  $message = $_.Exception.Message
  $message = $message -replace '\\', '\\'
  $message = $message -replace '"', '\"'
  $message = $message -replace "`r", ' '
  $message = $message -replace "`n", ' '
  [Console]::Out.Write('{"ok":false,"error":"' + $message + '"}')
  exit 1
}
