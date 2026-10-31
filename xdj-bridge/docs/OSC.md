# OSC schema v1

同一の`DeckState`から生成し、UDPのOSC immediate bundleで送ります。既定は毎秒30snapshot以下、設定例は20snapshot/s、状態更新がなくても1秒ごとにsnapshotを再送します。1snapshotが複数datagramになる場合も各bundleに共通ヘッダを付け、各datagramを1200byte以下に抑えます。

| パス | OSC型 | 意味 |
|---|---|---|
| `/dj/schema_version` | i | 1 |
| `/dj/session_id` | s | 起動ごとのセッションID |
| `/dj/revision` | s | 正規化状態のrevision、10進文字列 |
| `/dj/decks/{id}/revision` | s | デッキrevision、10進文字列 |
| `/dj/decks/{id}/deck_id` | s | 正規化デッキID |
| `/dj/decks/{id}/bpm` | f | トラックBPM |
| `/dj/decks/{id}/effective_bpm` | f | 実効BPM。ピッチを二重適用しない |
| `/dj/decks/{id}/pitch_percent` | f | ピッチ% |
| `/dj/decks/{id}/playing` | i | 既知のplaying=1、既知の停止/paused/cued=0 |
| `/dj/decks/{id}/tempo_master` | i | 観測したテンポMASTER状態。既知のtrue=1、false=0 |
| `/dj/decks/{id}/position_ms` | f | 実測絶対位置。根拠がなければ未送信 |
| `/dj/decks/{id}/beat` | f | 有効なトラック内beat番号 |
| `/dj/decks/{id}/beat_phase` | f | 最後の観測beat通知の小節内phase。自走しない |
| `/dj/decks/{id}/on_air` | i | 検証された場合のみ1/0。現実装は未取得 |
| `/dj/decks/{id}/title`, `/artist` | s | Providerから取得した曲名/artist |
| `/dj/decks/{id}/track_id` | s | uint32を精度損失なく表す10進文字列 |
| `/dj/decks/{id}/source_slot` | f | プロトコルのslot値。物理USBラベルを推測しない |
| `/dj/decks/{id}/source_device_id` | s | 読込元の正規化ID |

デッキごとの値パスにはそれぞれ`/valid`、`/quality`、`/fresh`を付加します。型はすべてOSC iです。

- `valid`: freshで既知かつ送信可能な値は1。null、unknown、stale、上限超過文字列は0。
- `quality`: unknown=0、observed=1、estimated=2。鮮度と独立しています。
- `fresh`: fresh=1、stale=0。

`valid=0`の場合、値パス自体を送りません。受信側は保持していた値を無効化してください。未知BPM/位置/再生状態を数値0で補いません。文字列は512 UTF-8 byteまでとし、超過時はvalid=0です。

## 代表デッキの共通ルート

全デッキの個別出力と同じ送信先へ、動的に選定した代表デッキの値も送ります。追加設定は不要です。

| パス | OSC型 | 意味 |
|---|---|---|
| `/dj/representative/valid` | i | 代表が選定できた場合1。候補なし・切断時は0 |
| `/dj/representative/public_deck_id` | s | 選定した公開ID。例えば`"2"`。valid=1のとき各bundleへ反復 |
| `/dj/representative/deck_id` | s | 選定した正規化デッキID。値ごとのvalid/quality/fresh付き |
| `/dj/representative/reason` | s | `tempo-master`、`playing`、`none`。各bundleへ反復 |
| `/dj/representative/bpm` | f | 代表のトラックBPM |
| `/dj/representative/effective_bpm` | f | 代表のピッチ反映後BPM |
| `/dj/representative/pitch_percent` | f | 代表のピッチ% |
| `/dj/representative/playing` | i | 代表の再生状態。既知の再生=1、停止/paused/cued=0 |
| `/dj/representative/tempo_master` | i | 代表の観測したテンポMASTER状態 |

選定は正規化された共通状態で行い、HTTP/WebSocketの`representative`にも同じ選定結果を含めます。

1. freshで観測済みのテンポMASTERがあれば優先します。MASTERが一時停止中でも代表を維持し、BPMが未知ならBPMのvalidだけを0にします。
2. MASTERが不明または存在しなければ、freshの再生状態と有効な正の実効BPMを持つ再生中デッキから選びます。
3. 同順位の候補が複数あれば現在の代表を維持し、通常の受信順で切り替わることを防ぎます。代表が候補から外れた場合は、論理デッキ番号・公開ID・正規化IDの順で決定的に選びます。
4. 公開IDが未確定・重複するデッキ、旧セッション、staleな候補は選びません。候補なしでは`valid=0`、`reason=none`となり、以前の代表IDを引き継ぎません。

`bpm`、`effective_bpm`、`pitch_percent`、`playing`、`tempo_master`、`deck_id`には、個別ルートと同じ`/valid`・`/quality`・`/fresh`が付きます。代表のvalid=1は、全項目が取得できたことを意味しません。受信側は項目ごとのvalidも確認してください。候補なしでは各値もvalid=0となり、値パスは送信しません。512 UTF-8 byteを超える内部deck_idは`/deck_id/valid=0`で明示的に解除し、短い公開IDによる帰属は維持します。

各datagramに`session_id`・`revision`・代表の`valid`・`reason`と、valid=1の場合は`public_deck_id`を付けます。**受信側はsession_idまたはpublic_deck_idが変わった時点で以前の代表値を破棄し、そのIDとrevisionに属する値だけを採用してください。** valid=0でも以前の代表値とIDを破棄します。同revisionの後続bundleは同じsnapshotの断片です。値全体の一括更新が必要ならWebSocketを使用してください。

MASTERは状態通知のフラグまたは公開Status APIの観測値を用います。On-Airやフェーダーから実際に聴こえるデッキを推測する機能ではありません。機種・FWごとのMASTER動作は実機受入対象です。

UDPは欠落・並替えがあります。受信側はsession_idを切替境界とし、古いrevisionを捨ててください。同じrevisionを持つ複数bundleは同一snapshotの断片なので、同revisionの後続bundleを捨てないでください。全項目の原子的更新が必要な場合はsnapshotを一括取得できるWebSocketを使用してください。

OSCの`id`はUIの公開デッキIDです。RX3は既定で1/2。AZ形式でwire 1〜4を観測した場合は1/2/3/4候補を出力し、例えばDeck 4は`/dj/decks/4/bpm`になります。デッキごとにvalid・鮮度・revisionを持ち、Deck 4が途絶してもDeck 1〜3の有効な値は送り続けます。AZの実機対応は未検証です。公開IDは`publicDeckIds`で変更でき、未確定・衝突中のデッキは出力しません。BPMから生成したsynthetic beatは現実装では送信しません。
