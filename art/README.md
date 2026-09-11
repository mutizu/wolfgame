# 役職イラストの生成条件

`public/images/*.webp` の元データ。webpは**このPNGを縮小せずそのまま**品質88で書き出したもの。

```
python3 -c "
from PIL import Image
Image.open('art/wolf.png').convert('RGB').save('public/images/wolf.webp','WEBP',quality=88,method=6)"
```

## 環境

Draw Things（プロトコルを **HTTP** に切り替えて port 7860）の A1111互換API。
`POST http://127.0.0.1:7860/sdapi/v1/txt2img`

| 項目 | 値 |
|---|---|
| モデル | `waiillustrioussdxl_v170_q8p.ckpt` |
| サイズ | 768 × 768 |
| ステップ | 26 |
| CFG | 5.0 |
| サンプラー | `DPM++ 2M AYS` |
| シード | `12345`（全枚共通） |

1枚あたり約25秒。

## 共通プロンプト

```
masterpiece, best quality, very aesthetic, anime style, (1girl:1.4),
(upper body:1.3), bust portrait, head and shoulders, looking at viewer, centered,
simple background, flat color, bold outline, high contrast
```

## ネガティブ

```
close-up, extreme close-up, face focus,
(bare shoulders:1.5), (cleavage:1.5), (bare arms:1.4), nude, off-shoulder,
(1boy:1.6), (male:1.5), (horror:1.3), (blood:1.4), (grotesque:1.4),
(colored skin:1.4),
lowres, worst quality, bad anatomy, bad hands, text, watermark, signature,
multiple views, blurry, cropped, out of frame, busy background, cluttered, nsfw
```

## 役職ごと

| 役職 | プロンプト |
|---|---|
| 人狼 | `wolf girl, (black wolf ears:1.3), (dark grey hair:1.2), (red eyes:1.3), small fang, confident fierce smirk, black jacket, dark red background` |
| 白狼 | `white wolf girl, (large white wolf ears:1.3), silver white hair, pale blue eyes, innocent unaware expression, light blue background` |
| 狂人 | `(smug grin:1.3), (narrowed eyes:1.3), (finger on lips:1.2), tilted head, (long purple hair:1.2), (yellow eyes:1.2), high collar purple coat, scheming expression, deep purple background` |
| 暗殺者 | `assassin, (black hood:1.2), (face mask covering mouth:1.25), (silver hair:1.2), (navy blue eyes:1.2), calm sharp gaze, (high collar black coat:1.4), (long sleeves:1.3), holding dagger, dark navy background` |
| 村人 | `young villager girl, (long brown hair:1.3), (braid:1.2), brown eyes, (linen tunic:1.2), (beige hooded cloak:1.2), high collar, long sleeves, calm ordinary friendly expression, warm brown background` |
| 占い師 | `fortune teller, (long blue hair:1.2), (golden eyes:1.2), gold star hair ornament, (pale peach skin:1.3), (dark indigo robe:1.2), gold trim, high collar, mystical serene expression, indigo background` |
| 付き人 | `(maid:1.4), (white maid headdress:1.4), (dark green maid dress:1.4), (white apron:1.3), high collar, long sleeves, (long dark green hair:1.2), grey eyes, gentle attentive expression, slight bow, sage green background` |
| てるてる | `(teru teru bozu:1.3), (round white cloth hood:1.4), (white poncho:1.2), covering head, (pale peach skin:1.4), (fair skin:1.3), (hopeful gentle smile:1.2), closed happy eyes, black hair, red ribbon at collar` ／ 背景は後述の方法で青緑に差し替え |
| 啓蒙家 | `scholar girl, (round glasses:1.3), (holding an open book:1.3), (long pink hair:1.2), (high collar academic robe:1.3), long sleeves, calm intelligent expression, (rose pink background:1.3)` |
| 狂信者 | `(zealot girl:1.2), (fervent devoted expression:1.3), (clasped hands:1.2), (long dark red hair:1.2), (high collar ceremonial robe:1.3), gold pendant, (pale peach skin:1.4), intense narrow eyes` ／ 背景を錆オレンジ(154,52,18)に差し替え |
| 告発者 | `(judge girl:1.2), (holding documents:1.3), (stern serious expression:1.3), (short blonde hair:1.2), (high collar formal coat:1.3), long sleeves, (pale peach skin:1.4), sharp eyes, raised hand` ／ 背景をマスタード金(161,98,7)に差し替え |

カード裏面だけは人物ではないので共通プロンプトを使わない。

```
masterpiece, best quality, (playing card back design:1.4), ornate emblem,
(crescent moon:1.2), wolf silhouette, symmetrical, centered, decorative border,
flat color, bold outline, dark indigo and silver, simple background
```
ネガティブに `(1girl:1.5), (1boy:1.5), (face:1.4), (person:1.4), portrait, character` を入れないと人物が出る。

## 追加するときの注意

**役職ごとに背景色を割り当てること。** 一覧のアイコンは42pxまで縮み、その大きさでは造形がほぼ消える。
見分けの手がかりは形ではなく色になるので、色は勘で選ばず**測って決める**。28pxに縮めた平均色を出し、既存の全役職との距離を計算して、
**最小距離がいちばん大きくなる背景色**を選ぶ。既存どうしの最小距離は37（人狼↔狂人／付き人↔てるてる）なので、
これを下回る候補は落とす。狂信者は錆オレンジで45、告発者はマスタード金で52だった。

この方法で候補も落とせる。狂信者の初稿は赤い法衣のキャラで、**背景をどの色にしても人狼との距離が17**にしかならず、
さらに背景に金の輪があって平坦でないため塗り替えも効かなかった（検出0%）ので不採用にした。

その他、実際にはまった点：

- `close-up face` を入れると**目のドアップ**になる。`(upper body:1.3)` とネガティブの `close-up` で抑える
- `blue violet color scheme` のような**シーン全体にかかる色指定は肌に漏れる**（肌が紫になった）。
  色は `(long blue hair:1.2)` `(dark indigo robe:1.2)` のように物体側に付ける
- 露出はネガティブで消すより**着せる物を明示する**方が安定する
  （`zipped up hoodie` / `high collar coat` / `knit sweater` / `white apron`）
- 怖くしないこと。影で顔を潰すとホラー寄りになるうえ、28pxで真っ黒な塊になって判別できない。
  「怪しさ」は暗さではなく**表情**で出す（細めた目・含み笑い・口元の指）
- `servant attendant` では軍服姿になる。付き人は `maid` と明示する

## 背景色が指定通りにならないとき

てるてるでは `teal` / `turquoise` / `mustard yellow` / `amber` のどれを指定しても
赤か暗色になり、さらに `warm amber background` は**肌をオレンジに**した。
モデルが概念ごとに背景色の癖を持っているらしく、プロンプトでは押し切れない。

**キャラだけ良い状態で出して、背景は後から塗り替えるほうが速い。**
背景は平坦な単色なので、四隅の色を基準に縁から塗りつぶせば線画で止まる。

```python
# 四隅の中央値を背景色とみなし、色距離がTOL以内の画素を縁からBFSで塗る。
# 太い輪郭線が壁になるので、髪や布の中までは入らない。
TOL = 60
dist = np.sqrt(((a - bg) ** 2).sum(axis=2))
cand = dist < TOL
# ... 縁からBFS ...
alpha = np.clip(1 - dist / TOL, 0, 1)[..., None] * mask[..., None]
out = (out * (1 - alpha) + TARGET * alpha).astype(np.uint8)
```

`alpha` を距離で減衰させると境界のジャギが出ない。てるてるは TARGET=(20,116,110)。

## カットインの立ち絵（cutin-*.webp）

背景を透明にして、演出の上に重ねる。生成→切り抜きの手順は「背景色が指定通りに
ならないとき」と同じ塗りつぶしだが、**塗り替える代わりにアルファを0にする**。

| 用途 | プロンプト | 切り抜きの許容値 |
|---|---|---|
| 告発者 | `(short blonde hair:1.2), (high collar black coat:1.3), long sleeves, (pale peach skin:1.4), sharp blue eyes, (pointing at viewer:1.5), (shouting:1.3), (angry determined expression:1.3), (holding documents in other hand:1.3), leaning forward, dynamic pose` | 45 |
| 暗殺者 | `(black hood:1.2), (face mask covering mouth:1.25), (silver hair:1.2), (navy blue eyes:1.2), (high collar black coat:1.4), long sleeves, (pale peach skin:1.4), (holding dagger up:1.4), (lunging forward:1.3), sharp intense gaze, dynamic pose` | 28 |

共通プロンプトは bust portrait ではなく `upper body` にし、背景に
`(plain flat background:1.4)` を足す。切り抜くので背景は平坦なほど良い。

**許容値は必ず現物で確かめること。** 告発者は白い書類と明るい髪が背景に近いので、
60まで緩めると髪が背景ごと溶けた。暗殺者は黒服と濃紺背景が近いので逆に絞る必要があり、
28でも50でも結果が変わらない（=きれいに分離できている）ことを確認してから決めた。
