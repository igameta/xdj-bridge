# XDJ Bridge

XDJの状態を取得し、ブラウザで可視化し、同じ正規化状態をOSC/UDPに出力するソフトウェア。`BACKEND-ADAPTER-DESIGN-20261026.md`を基にした初期実装です。

実装・監査日: 2026-10-31 (Asia/Tokyo)。今回の検証は保存済みRX3通信・合成パケット・ローカルHTTP/WebSocket/UDPを使用しています。今回の実装による実機接続、AZの4デッキ・NFS・波形の実機検証は行っていません。

## 起動

Node.js **22.18以降**とnpmを使用します。Python/Java、rekordbox、DJのUSBデータベースの事前コピーは不要です。

```sh
cd xdj-bridge
npm ci
npm run build
npm start
```

ブラウザで `http://127.0.0.1:8080` を開きます。通常起動は未接続です。右上のハンバーガーメニューから接続先・OSC設定を開きます。「機器」のプルダウンから自動検出・XDJ-RX3・XDJ-AZ等を選び、ネットワークインターフェースと接続方法を指定して「接続」を押します。選択の変更だけでは通信しません。「切断」で停止し、別の接続先へ切り替えられます。メニューは閉じるボタン・Escape・背景クリックで閉じられ、閉じても入力と受信を維持します。

「OSC出力」で有効/無効、送信先ホスト、ポート、更新頻度を変更して「適用」を押します。設定変更はこのPCから行えます。画面上の設定は実行中のプロセスに適用し、設定ファイルへは書き戻しません。再起動時にも同じ値を使う場合はconfigファイルを指定してください。OSCは明示的に設定するまで無効です。終了はCtrl+C。

生成データでの確認は`npm run demo`で起動します。既定はRX3形式の2デッキです。4デッキは`npm run demo -- --demo-decks 4 --port 8081`で確認できます。別ポートを使うため、8080で受信中のアプリを停止する必要はありません。画面に「デモデータ」と明示し、拍・位置・曲名を捏造しません。4デッキのデモはAZ形式の合成パケットで、AZ実機の対応確認を意味しません。

[受信画面](docs/receiver.png) / [設定メニュー](docs/settings-menu.png)

4デッキの表示例（合成データ）: [デスクトップ](docs/four-decks.png) / [モバイル](docs/four-decks-mobile.png)

```sh
# 接続IFを表示。機器への参加通知は送りません
npm start -- --list-interfaces

# RX3: USB-B接続で現れるIFを実際の名前に置き換える
# 他のrekordbox/BLT/bridgeが同じUDPポートを利用していない状態で起動
npm start -- --mode virtual-device --interface en6 --osc 127.0.0.1:9000

# 受信のみ。他の参加者などにより状態配信が既に成立している必要があります
npm start -- --mode passive --interface en6

# 保存済み実機通信を再生。機器へは一切送信しません
npm start -- --mode replay --capture ../captures/rx3-20261005-python-virtual-cdj.pcapng

# 高速再生/反復。speedを変更しても状態の時刻はキャプチャ相対時刻です
npm start -- --mode replay --capture ../captures/rx3-20261005-python-virtual-cdj.pcapng --speed 2 --loop

# alphatheta-connect公開PcapAdapter経由の受動キャプチャ
npm start -- --mode passive --backend alphatheta --interface en6

# 設定ファイル。IF/IPは現場の値へ変更してください
npm start -- --config config.example.json
```

`--help`で全オプションを表示します。既定HTTP待受はlocalhostです。`--host`で変更できますが、HTTP側のHost/Origin検査を有効にしているため、表示したURLのホスト名でアクセスしてください。受信側を別PCに置く場合はOSC宛先を設定します。

## LAN内の機器探索

ネットワークインターフェースの選択は、機器1台ではなく接続するLANの選択です。同じスイッチにつながった複数のCDJ/XDJから、送信元IPと通信番号を分けて受信できます。機種が混在する場合は「自動検出」を使います。

メニューでEthernetの接続先を選び、「機器を探す」を押します。通常6秒間、UDP 50000の機器通知を待つ受信方式で、参加通知・IP範囲への問い合わせを送りません。既に同じLANを受信中なら既存の受信結果を利用し、その接続を維持します。別のLANを探索する場合は先に切断します。探索中の新規接続は受け付けません。

モデル・送信元IP・通信番号・最終受信時刻を一覧に表示します。同一本体が複数の通信番号を持つことがあるため件数は台数と同じとは限りません。「機器通知のみ」「状態受信中」「状態受信停止」を区別し、最後の通知から6秒を超えたものは受信途絶として保持します。最大128件です。nativeの受信IFはサブネットからの推定で、異なるサブネットの通知を拾った場合はIF未確定として表示し、その機器への参加や状態取得は行いません。探索で見つからないことは、そのLANに機器がない証明ではありません。機器通知だけでデッキ値を作ったり、OSC・OS通知を開始したりしません。

Windowsの現場で見つからない場合は、次の順に確認します。

1. スイッチへ接続したEthernetのIFを選び、PCのIPv4・ネットマスクとAZの「Ethernet Info」を照合します。選択LANの状態取得・仮想参加には同一サブネットが必要です。Wi-Fi/VPN等とアドレス範囲が重なる場合は、nativeが曖昧な経路を拒否します。
2. rekordbox、Beat Link Trigger、別のbridge等によるUDP 50000/50001/50002の占有を確認します。アプリのポート確保エラーと、通知未受信は分けて確認してください。
3. [Windowsセキュリティのファイアウォール設定](https://support.microsoft.com/en-us/windows/security/windows-security/firewall-and-network-protection-in-the-windows-security-app)で、使用中のネットワーク種別に対するNode.jsの受信許可と、必要なUDP 50000〜50002の受信ルールを確認します。ファイアウォール全体を無効にする必要はありません。
4. AZのPRO DJ LINK設定と内蔵Wi-Fiの状態を、下記の公式マニュアルと照合します。「機器通知のみ」なら機器の存在通知までは届いていますが、デッキ状態の配信はまだ確認できていません。仮想参加は明示的な「接続」で開始し、探索から自動移行しません。

今回のLAN探索は合成パケットで検証しています。現場のWindows・スイッチ・AZで実測しておらず、報告された取得失敗の原因は未確定です。

[探索表示の例（合成データ）](docs/network-discovery.png)

### AZ: PRO DJ LINK Mode OFFでの試験

本体のModeは**OFFのまま**、メニューの機器を「XDJ-AZ」または「自動検出」、接続方法を「AZスタンドアロン（試験）」にして「接続」を押します。選択だけでは送信しません。現場の**FW 1.23 / Windowsは実機未検証**で、参考報告のFW 1.30での成功を保証しません。本体設定・FW・通常の接続方式を自動変更しません。

```sh
# Ethernetは現場のIF名に置き換える。試験する場合だけ明示指定する。
npm start -- --mode az-standalone --profile xdj-az --interface Ethernet
```

6秒間送信せずに観測し、未使用の5、次に6を選んでPC型の参加通知を試します。番号1〜4は使わず、番号の強制指定は受け付けません。両番号の占有や別機種のプレーヤーを検出した場合は停止します。事前通知がなくても、この明示試験だけで送信を試みます。最初の送信後10秒間、解釈できるAZ状態が来なければ送信と接続を終了し、受信開始後も5秒の途絶で停止します。

4デッキ表示の合成テストは、本体4デッキの取得成功を意味しません。Mode OFFを保った実機で4つの曲・再生操作と受信値を照合する必要があります。曲名・波形等の標準Providerも未実装で、「全情報取得済み」とは扱いません。根拠・送信仕様・必要な実機照合は[AZ OFF運用の調査記録](docs/AZ-OFF-RESEARCH-20261031.md)を参照してください。

[試験モードの設定画面](docs/az-standalone-settings.png)

## 可視化と出力

- デッキごとの実効BPM、トラックBPM、ピッチ、再生状態、曲ID、読込元を表示します。
- 曲名を20px、アーティストを16px（狭幅では18px・15px）で大きく表示し、長文は2行まで表示します。全文はツールチップで確認できます。
- 受信がfreshで再生中と判定できるデッキを色枠で強調します。一時停止・停止・不明・受信途絶では強調を解除します。4デッキは2列×2段、幅820px以下では縦に並びます。
- 接続先とOSC設定を画面から操作できます。能力の検証・利用状態、アダプタ選択理由、診断は必要時に展開できます。
- 接続先・OSC設定は通常非表示で、メニューから開きます。受信の画面更新は最大20回/秒へ集約し、既存のカード・展開状態・フォーカスを維持します。ネットワーク候補は一定順に並べ、選択操作中は候補を更新しません。
- 接続状態は固定サイズのバッジで表示します。詳しい理由文は「診断」内の直近メッセージとして保持し、空の通知では消しません。理由の有無によってデッキ表示の位置が動くことはありません。
- `null`は未取得、受信途絶は最後の値を保持した`stale`として表示します。
- 曲名・アーティスト・On-Air・拍・絶対位置は、根拠がない場合は未取得です。波形の代わりに架空の波形は表示しません。
- HTTP `GET /api/state`、`/api/health`、`/api/runtime`、WebSocket `/ws`を提供します。
- `POST /api/connection`で接続・切断、`POST /api/osc`でOSC設定、`POST /api/discovery`の`{"interfaceName":"Ethernet"}`で探索を開始します。IF名は実際の値に置き換えてください。探索結果は`GET /api/runtime`の`discovery`、セッションで観測した機器は`GET /api/state`とWebSocketの`devices`に含まれます。設定・探索POSTはlocalhostからのJSON要求のみ受け付け、Origin/Hostと4KiBのサイズ上限を検証します。
- WebSocketはschemaVersion付きsnapshotから開始し、baseRevision/revision付き差分を配信します。`{"type":"resync"}`で最新snapshotを要求できます。遅い購読者は最新状態に集約します。
- 接続先を切り替えると新しいsessionIdとsnapshotへ移行し、旧セッションの遅い通信は表示・出力へ混入させません。OSC宛先変更時は旧宛先へ無効化を送ってから新しい出力を開始します。
- OSCのパス・型・valid/quality/fresh・revisionの扱いは[OSC仕様](docs/OSC.md)を参照してください。
- 全デッキの個別OSCに加え、`/dj/representative/effective_bpm`等へ代表デッキを出力します。freshで観測済みのテンポMASTERを優先し、MASTERが不明・不在ならfreshの再生中デッキ（実効BPMが有効）から選びます。同順位は現在の代表を維持し、候補なしや切断では明示的にvalid=0を送ります。`/dj/representative/public_deck_id`で選定元、`/reason`で選定理由を取得できます。受信側はセッションまたは代表の公開IDが変わったら前の代表値を破棄してください。

`publicDeckIds`は`"機器IP:wire番号": "公開デッキID"`で設定します。同一ネットワークに複数本体がある場合に番号を固定できます。RX3の既定対応はwire 11→Deck 1、12→Deck 2です。未知番号を機械的に差し引きません。公開IDが他のデッキと衝突した場合、そのデッキのOSC出力を保留し診断します。

### 4デッキ

受信・状態管理・WebSocket・OSCは受信したデッキをすべて扱います。デッキ数の設定やデッキごとの参加者の起動は不要で、同一セッションでDeck 1〜4の通知を受けると4デッキ分が生成されます。デッキごとの曲切替・取得値・鮮度を独立して保持し、1デッキの途絶で他のデッキを停止しません。

XDJ-AZは画面の機器選択で`XDJ-AZ`、接続先でEthernetのIFを選んで接続します。実装上は観測されたwire 1〜4を論理Deck 1〜4の候補として扱い、OSCは`/dj/decks/1/...`〜`/dj/decks/4/...`へ出力します。デッキごとの通知が来るまで空のデッキ状態は生成しません。AZの番号対応・共有メディア・仮想参加は実機未検証で、能力表示も未検証を維持します。RX3本体の2デッキを4デッキに増やす機能ではありません。

AZの[公式マニュアル「PRO DJ LINK Mode」](https://downloads.support.alphatheta.com/manuals/all-in-one-dj-systems/XDJ-AZ/html/en/000COV_en/Settings/Settings.htm)では、このモードをOnにすると本体のDeck 3/4を使用できず、内蔵Wi-Fi使用中はPRO DJ LINKプレーヤーへ接続できないとされています。アプリの4デッキ表示・合成テストは、AZ本体の4デッキを同時にLANから取得できる保証ではありません。本体のモード変更は演奏への影響を確認して行ってください。

複数のCDJや本体が混在し、既定の公開IDが重複する場合は、設定ファイルで固有の公開IDを割り当てます。例えばAZ候補の4デッキを`az1`〜`az4`に固定する設定は次のとおりです。IPは実際の機器IPに置き換えてください。

```json
"publicDeckIds": {
  "192.0.2.50:1": "az1",
  "192.0.2.50:2": "az2",
  "192.0.2.50:3": "az3",
  "192.0.2.50:4": "az4"
}
```

4デッキの合成デモは`--demo-decks 4`またはJSONの`"demoDecks": 4`を`mode: demo`と組み合わせます。デモで`--profile`も指定する場合は、4デッキに`xdj-az`、2デッキに`xdj-rx3`を使います。`auto`と`generic-prolink`も選択できます。実機のデッキ数はこのオプションでは変更しません。

## 対応範囲

| 機能 | RX3 | AZ / 汎用 |
|---|---|---|
| 状態デコーダ | 保存fixture・実pcapngで回帰検証 | 実装済み、合成テスト、実機未検証 |
| 論理デッキ | wire 11/12→1/2 | AZ wire 1〜4候補、通知に従い生成。実機未検証 |
| BPM・実効BPM・ピッチ・曲ID・再生状態 | 保存済み通信に一致。今回のlive実機試験は未実施 | 汎用形式を実装、実機未検証 |
| 仮想参加 | 既存の実機確認済みPython手順をTSへ移植。番号選択・競合停止・排他bind | 同じ基本手順、実機未検証 |
| 拍 | 無効カウンタはnull。観測した通知のみ使用 | パケット境界を実装、実機未検証 |
| 絶対位置 | 未確認のため通常null | 絶対位置パケットのみ実装、実機未検証。補間は未実装 |
| 曲名・アーティスト | Provider差込口・世代チェック・有限スケジューラ。標準Providerなし | NFS/dbserver Providerは未実装 |
| 波形・beat grid・cue | 未実装 | 未実装 |
| On-Air・フェーダー | 未検証のためnull | 機種別MixerDecoder未実装、null |
| ファームウェア識別 | unknown | unknown |

RX3で曲IDを取得できても、DJが挿したUSBから曲名・アーティストを直接取得する目的が完了したとは扱いません。AZ全機能対応も表示しません。本体モジュールの導入・変更は行いません。

## セッションと安全な失敗

通常の`virtual-device`は、明示IFを選択し、UDP 50000/50001/50002をすべて排他的に確保してから参加します。通常6秒の観測後、観測済み参加者・論理デッキの番号を避けて7〜9から選び、Hello→番号確保→1.5秒周期keepaliveを送ります。RX3は保存通信に対応するbroadcast経路を維持し、それ以外のCDJ/XDJには観測した各IPへunicastで参加通知を送ります。このLAN参加経路はAZを含め実機未検証です。Stagehandの追加プロトコルは実装せず、RX3とStagehandが混在する場合はbroadcast参加を停止します。番号競合時は送信を止め、全ソケットを解放します。明示モードが失敗しても通信方式を暗黙変更しません。

Nodeの標準UDP APIはmacOSの`IP_BOUND_IF`や受信IF・送信先IPの補助情報を公開しません。仮想参加のUDP 50002は選択IPv4へbindして送信元を固定し、50000/50001はbroadcast受信のためwildcard bindを使います。受信のみのnative passiveでは50002もwildcard bindとし、IP宛のunicastとbroadcast状態通知を受けます。選択IFと重なるネットワークを他IFが持つ場合は**起動を拒否**し、動作中の変更も検査します。曖昧な環境で厳密IF束縛を保証するものではありません。Wi-FiとUSBが同じ169.254/16を持つ場合などは、重なる接続を無効にするか、明示IFのpcap passiveを使ってください。通常の状態取得は選択した唯一のサブネットの通信のみ採用します。native passiveはこのプロセス宛・broadcastが対象で、スイッチ上の他PC宛unicastを受信できる前提にはしません。

AZ試験モードは50002の状態受信を維持し、同じ選択IPv4へbindした一時ポートの送信ソケットを追加します。計4ソケットを同じセッションで管理し、終了時にはすべての解放を待ちます。

比較した一次実装は、[beat-linkのDeviceFinder](https://github.com/Deep-Symmetry/beat-link/blob/ef0aaa1ea949f5c3b1e759973f784c488a12288a/src/main/java/org/deepsymmetry/beatlink/DeviceFinder.java)が50000をwildcard、[VirtualCdj](https://github.com/Deep-Symmetry/beat-link/blob/ef0aaa1ea949f5c3b1e759973f784c488a12288a/src/main/java/org/deepsymmetry/beatlink/VirtualCdj.java)が50002を選択IPv4へbindし、[alphatheta-connect](https://github.com/chrisle/alphatheta-connect/blob/7496991060a38951c2119db13c26b3da7c075bfa/src/network.ts)は3ポートともwildcardを使用しています。旧50002のIPv4 bindはbroadcast状態通知を受けにくい条件になり得ますが、それだけで今回の現場の失敗原因とは断定していません。

`--backend alphatheta`は公開`PcapAdapter`のみを使うcapture-only方式です。受信IFはpcapで指定し、他参加者への通信の可視性はネットワーク構成次第です。libpcap/Npcap・`cap`とOSのパケットキャプチャ権限が必要です。参加通知・NFS・dbserver要求は送りません。未検証の上流status parser/Stagehand mixer decoderを直接使用しません。上流PacketInfoに含まれない送信元port・送信先IPは0/0.0.0.0のunknown sentinelです。

受信IFの消失・IP変更や競合を検出したらセッションを停止します。状態の停止・途絶はstaleへ移行します。接続を戻した後は画面で接続先を選び直し、「接続」を押してください。自動再参加・別IFへの自動切替は未実装です。

TrackRefはメディア所有者・wire slot・mediaGeneration・track ID・track typeを含みます。曲切替・観測したメディア交換・再接続で世代を更新し、旧曲のtitle/artist/positionを解除します。メディア交換を通知から検出できない機種もあるため、受信途絶と再接続でもキャッシュを保守的に無効化します。同一曲IDだけで同一USBと断定しません。

## 構成と拡張

```text
src/transport/live.ts        IF選択・RX3仮想参加・UDP排他管理
src/transport/replay.ts      純TS pcap/pcapng読込・時刻を保つ再生
src/runtime.ts               画面操作・接続切替・OSC設定のライフサイクル管理
src/adapters/alphatheta.ts   公開PcapAdapter/状態イベント変換境界
src/adapters/providers.ts   MetadataProvider差込口と有限要求スケジューラ
src/core/decoder.ts         入力検証・機種別解釈
src/core/store.ts           正規化状態・世代・鮮度・能力・revision
src/output/server.ts        HTTP/WebSocket
src/output/osc.ts           同じ状態からOSC/UDP出力
public/                    外部CDN不要の可視化UI
```

Providerはセッション内で共有する`ProviderScheduler`を通します。現実装はロード世代につき1回の有限試行です。timeoutはunsupportedに変換せずunavailableにし、次のロード・メディア世代で再試行します。AbortSignalに従わない処理は終了するまで同時実行枠を保持し、timeout後の孤児リクエスト増殖を防ぎます。外部JavaScriptプラグインの自動ロードはありません。

採用ライブラリは`alphatheta-connect@0.28.5`です。公開パッケージにも残る`file:../metadata-connect` / `file:../onelibrary-connect`依存を、ルートnpm overridesで`metadata-connect@1.2.2` / `onelibrary-connect@1.1.6`へ解決し、lockfileを固定しています。上流の内部deep importやmonkey patchは使いません。native/replay/OSC/UIはこのoptional依存がなくても動作します。

```sh
# optional native依存なしの最小インストール
npm ci --omit=optional
npm run build
npm test

# pcap用optional依存も導入
npm ci --include=optional
```

依存先のコードは各ライセンスに従います。パケット仕様の根拠はリポジトリの設計・実機記録、alphatheta-connect(MIT)、既存Python調査ツールです。beat-linkのコードは製品コードにコピーしていません。

## OS通知（macOS）

メニューの「通知」で「再生状態の変化を通知」をチェックし、「適用」を押すと有効になります。既定はOFF、現在はmacOSのみ対応です。ブラウザの通知許可は使用しません。[通知設定の画面](docs/notifications-menu.png)

デッキごとのobservedかつfreshな再生状態の変化を通知します。初回受信、ON直後、接続・曲ロードの変更、不明値や受信途絶からの復帰では通知しません。BPM・メタデータだけの更新も対象外です。デモと保存キャプチャ再生は通知タイトルで区別します。通知の失敗で受信やOSCを停止することはありません。

AppleScriptの[display notification](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html)で通知を要求します。通知音はアプリから指定しません。macOSの通知設定や[集中モード](https://support.apple.com/en-gb/guide/mac-help/mchlff5da36d/27/mac/27)により表示されない場合があり、送信処理の正常終了は実際の表示確認を意味しません。今回はfake送信と構文コンパイルまでを検証し、実OS通知・バナー表示は未確認です。

## 検証と配布

```sh
npm test
npm run package
# npmキャッシュが揃った環境でクリーンインストール/配布物を再検証
node scripts/validate-release.mjs
```

テストにはRX3実fixture、実pcapngの存在時の回帰、pcap/pcapng両endian・時刻分解能、曲切替・媒体交換・再接続・旧応答、未知値・鮮度、OSC実UDP受信、WS復旧、IF競合、Provider timeout、接続切替の競合、制御API、OSC宛先切替・失敗時の復帰を含みます。2026-10-30の4デッキ追加では、合成パケットから状態・WebSocket・OSCへの経路、デッキ別の値・鮮度・公開IDを回帰検証しています。監査結果は[AUDIT.md](AUDIT.md)を参照してください。

`artifacts/xdj-bridge-0.1.0-runtime.tar.gz`にはコンパイル済みJavaScript・UI・package/lockfile・説明を収録します。展開先でNode.js 22.18以降とnpmを用意し、`npm ci --omit=dev --omit=optional`→`npm start`で起動できます。現場でTypeScriptコンパイルは不要です。pcapを使う場合は`--omit=optional`を外してOS別native依存を導入してください。Nodeバイナリ込みの単体アプリ、各OS/CPUでの配布認証は今回の範囲に含めていません。
