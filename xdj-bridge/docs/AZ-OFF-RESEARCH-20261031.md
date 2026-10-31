# XDJ-AZ: PRO DJ LINK Mode Offでの取得経路調査

調査日: 2026-10-31 (Asia/Tokyo)。資料と実装の読取のみ。AZ実機、現場Windows、8080の接続、通知、ファームウェアへの操作は行っていない。

## 判断

**Off運用での4デッキ取得を不可能と断定する根拠はない。一方、このアプリがOffで取得できることも未実証。** 外部プレーヤーとの連携設定と、PC向けrekordbox Link Exportの経路を分けて調べる必要がある。

優先する候補は「Offのまま、公式rekordboxとのLANまたはUSB Link Export通信を受動観測する」。4デッキ状態を確認できた場合に、その実測を基にPC向け参加方式を独立したSessionStrategyへ実装する。

## 確認した事実

### 公式仕様

- [Settings](https://downloads.support.alphatheta.com/manuals/all-in-one-dj-systems/XDJ-AZ/html/en/000COV_en/Settings/Settings.htm): PRO DJ LINK Modeは外部の対応プレーヤーとの接続を設定する。既定Off。Onにすると本体Deck 3/4を使えない。
- [Part names](https://downloads.support.alphatheta.com/manuals/all-in-one-dj-systems/XDJ-AZ/html/en/000COV_en/Part_names/Part_names.htm): LINK端子は外部プレーヤーとPC/Macの両方を接続対象とし、Onが必要という注意は外部プレーヤーへの接続について記載する。
- [Connections](https://downloads.support.alphatheta.com/manuals/all-in-one-dj-systems/XDJ-AZ/html/en/000COV_en/Connections_%28basic_styles%29/Connections_%28basic_styles%29.htm?rhtocid=_7): rekordbox Link ExportはLAN・USB・Wi-Fiに対応。WindowsのUSB接続には専用Link Exportドライバーが必要。AZの内蔵Wi-Fi使用中はLAN/USB Link Exportを利用できない。
- [PC/Mac setup](https://downloads.support.alphatheta.com/manuals/all-in-one-dj-systems/XDJ-AZ/html/en/000COV_en/PC_Mac_setup/PC_Mac_setup.htm?rhtocid=_3): 音声ドライバーとWindows USB Link Exportドライバーは用途が別。

これらはPC向け通信を調べる根拠になるが、Offで全4デッキのUSB再生状態を第三者ソフトへ配信する保証ではない。

### prolink-monitorの実機報告

[README](https://github.com/fidow/prolink-monitor/blob/main/README.md)はAZ FW1.30 / Windows 11の1台で検証したと明記し、wire 1〜4とmixer 33、4デッキの状態変化、NFSを報告している。ただしPRO DJ LINK Modeの設定値は記載していない。「Offで実証」とは引用できない。

参加方式には現アプリとの差がある。

- [proto.py](https://github.com/fidow/prolink-monitor/blob/main/prolink/proto.py#L213): rekordboxの実キャプチャ由来のkeepaliveを使う。layout値0x21=3、末尾0x34=4 / 0x35=8。
- [link.py](https://github.com/fidow/prolink-monitor/blob/main/prolink/link.py#L159): 既定番号5。3つのUDPポートをwildcard受信し、別の送信ソケットで50000へ定期broadcastする。CDJの番号claimシーケンスは行っていない。rekordbox併用時はNpcapで受動取得する。
- 現アプリの`src/transport/live.ts:67`はCDJ型keepalive(layout=2、末尾1/100)と番号7〜9・claim手順を採用している。

**推測:** Off時にPCとして認識される参加方式と、外部CDJとして参加する方式の差が原因候補になる。どの差が必要かは切り分けていない。単に番号5や末尾値へ変更すれば動くとは言えない。

[当該リポジトリのissue](https://github.com/fidow/prolink-monitor/issues/1)ではライセンス追加が求められており、コード転用は避ける。ここでは通信仕様の観測報告として参照した。

### 別実装者の明示的な4デッキ対応報告

[TimecodeLinkの公式製品ガイド](https://timecodelink.com/tutorial/pioneer)は、0.1.4以降でAZのstandalone 4-deckを扱い、アプリ側でネットワークデータを起動させると説明している。外部CDJを接続する場合はPRO DJ LINKをOnにして本体Deck 1/2に制限する、と区別している。Off運用を調べる価値を示す開発者の一次報告だが、起動パケット仕様・Windows対応・現場FWの検証結果はこのページからは分からない。

## ローカル基盤ライブラリの実態

### beat-link

ローカルcommit: `ef0aaa1ea949f5c3b1e759973f784c488a12288a`。

- `DeviceAnnouncement.java:60,195`はAZを識別し、非標準モードに言及している。
- `BeatFinder.java:134`はAZからのOn-Air通知でPRO DJ LINKモードらしさを判定する補助メソッドを持つ。
- しかし`VirtualCdj.java:1157`でLighting proxyへ分岐する実条件は`device.isOpusQuad`だけ。AZはその条件に含まれない。`canSeeXdjAzInProDJLinkMode()`も、このチェックアウトでは定義以外の利用を確認できなかった。
- `VirtualRekordbox.java:522,648`にはrekordbox Lightingの参加による状態取得処理があるが、記述・起動経路はOpus向け。`0x10` helloや`0x56` metadataを扱い、別番号変換・PSSI照合等を伴う。

したがって、AZ識別フラグや将来対応のコメントを「AZ Offの4デッキ対応済み」と解釈してはいけない。Opusの要求をAZへそのまま送る試験も行っていない。GPL実装からのコードコピーはしていない。

### alphatheta-connect

ローカルcommit: `7496991060a38951c2119db13c26b3da7c075bfa` / v0.28.5。

- `src/passive/README.md:101`はAZ/XZのUSB仮想NICに言及する。
- `src/passive/alphatheta.ts:237`のWindows検出はGet-NetAdapterの説明名・MACを使う汎用探索。AZ実機でのUSB通信成功を証明するテストではない。
- `docs/ALL_IN_ONE_UNITS.md:109`はAZをUntestedとしている。
- `src/virtualcdj/device-id.ts:78`のAZ=4は番号競合を避ける上限表で、Off時の4デッキ取得の検証ではない。
- Opusの資料は`docs/opus-quad-support-plan.md`という計画。AZのLighting要求を実証するものではない。

ローカル`captures/`からAZの実パケットを確認できなかった。RX3のUSB仮想NIC記録をAZへ一般化しない。

## Offを保つための次の観測手順

これは現場で選んで実施するための案であり、今回実行していない。取得対象はDJがAZ本体へ挿したUSBの再生状態で、DJごとのライブラリコピーは求めない。

1. Offを維持し、本体Deck 1〜4が使えること、FW、Windows版、接続構成を記録する。LAN/USB Link Exportを調べる場合は、AZ内蔵Wi-Fiとの排他条件を確認する。
2. Windowsの`Get-NetAdapter`と`Get-NetIPAddress -AddressFamily IPv4`でPC側IFを記録。Wireshark/Npcapの`dumpcap -D`または`tshark -D`で対応IFを確認する。
3. まずbridge等の参加を止めた状態で選択IFを30秒程度受動記録する。capture filter例: `arp or (udp portrange 50000-50004)`。これは送信を伴わない。50000の通知がゼロでも「全経路不可能」とは判定しない。
4. 次に公式rekordboxのEXPORTモードで通常のLink Export接続を成立させ、同じIFで受動記録する。AZのSOURCEでPCが認識されることを確認する。SOFTWARE CONTROLへの変更はstandalone再生とは別のモードなので代替成功と数えない。
5. AZ本体USBの曲をDeck 1〜4へロードし、各デッキの再生・一時停止を順に観測する。`0x06`通知のwire番号、`0x0a`状態の送信元/送信先/292-byte等の形式、`0x10`や`0x56`の有無を記録する。デッキ操作と数値の対応は推測せず照合する。
6. LANの公式接続が成立しない場合は、Windows用Link Exportドライバーを用意した上で背面PC用USB接続を別に調べる。新しいネットワークIFが現れるかを確認してからそのIFを記録する。ドライバー導入とUSB接続だけで4デッキ取得を保証しない。
7. pcapngを保存してオフライン解析する。現在のbridgeは通常のstatus type `0x0a`を扱うが、Lighting専用要求・再構成は未実装。未知パケットを標準状態として無理に解釈しない。

## 観測結果ごとの実装判断

| 観測 | 次の判断 |
|---|---|
| Offのまま公式PC接続で通常statusが4デッキ分届く | 受動取得の実証として固定fixture化し、PC向けSessionStrategyを別候補にする |
| USBの仮想NIC経由だけで通常statusが届く | USB transport profileを独立検証。Ethernetでの成功とは分ける |
| Lighting hello/type0x56だけ届く | AZ専用仕様を追加調査。Opus送信の無条件流用はしない |
| 公式Link Exportも成立せず、通知もない | 設定・ドライバー・IF・ネットワークを切り分ける。コードだけで可能とは主張しない |
| 曲IDはあるが曲名・波形がない | NFS/OneLibrary Providerは独立課題。PDBとOneLibraryの曲IDを同一視しない |

結論として、候補は十分あるが、現場Off通信の受動キャプチャが実装方針を決める最も確実な次の資料になる。

## 明示選択するPC型参加候補の実装

ユーザーの現場FWは**1.23**。参考の1.30とは異なり、FW更新・Mode変更を試験の前提にしない。現場での成功はまだ確認していない。

`az-standalone`を新しい試験モードとして追加した。通常起動は引き続きidleで、従来のRX3/virtual-device経路を自動置換しない。

```sh
# 現場で明示的に試す場合だけ。IFはWindows側の実際の名前に置き換える。
npm start -- --mode az-standalone --profile xdj-az --interface Ethernet
```

画面では「AZスタンドアロン（試験）」を選択する。profileはautoまたはxdj-azのみ。`deviceNumber` / `--device-number`の強制指定がある場合は、7〜9を黙って置き換えず開始前に拒否する。

送信・受信の境界は次のとおり。

- UDP 50000/50001/50002を排他確保し、6秒以上は送信せず番号を観測する。未使用5、次に6を選び、両方占有なら送信しない。1〜4は使用しない。
- 通知がゼロでも、この試験モードを明示選択した場合だけPC型presenceを送る。既知の非AZプレーヤーが見えるLANは混在試験の対象外として送信前に拒否する。動作中に現れた場合も停止する。PCやmixerをプレーヤーと決めつけない。
- 使用するpresenceは独立したencoderで組み立てる。type6、54byte、layout3、PC role 4、末尾8、count1を固定した観測テンプレートとし、CDJのHello/番号claim、Lighting、Stagehand要求は送らない。参考実装のソースコードは転用していない。
- AZ試験の送信は選択IPv4にbindした専用ephemeralポートから行い、状態受信は選択IPv4:50002に保持する。従来virtual-device/RX3の送信元50002は変えない。
- 送信先は選択サブネットのbroadcastと、実際に観測した同サブネットAZのunicastだけ。全体broadcast `255.255.255.255`へ送らない。1.5秒間隔でpresenceを再送する。
- 返信は既存decoderのmagic/port/type/既知layout/長さ検証に加え、AZ名と選択サブネットで制限する。他機種をAZとして解釈しない。得られたデッキだけを共通状態・OSCへ出す。波形・曲名Providerを成功扱いしない。
- 最初のpresence後10秒間、解釈できるAZ状態が来なければ全送信とソケットを停止する。受信開始後の途絶は5秒で停止する。番号競合、IF変更、切断でも停止・解放する。失敗時にMode OnやFW更新へ自動誘導しない。

参考との差として、選択IPv4を明示bindし、global broadcastを使わず、観測したAZへunicastも送る。これらはIFの曖昧な選択を避けるための境界であり、参考と同一の実機条件を再現したものではない。FW1.23、Windowsでの実行、AZ Offからの復帰、4デッキの状態・メタデータ取得はいずれも未検証として表示する。

検証は偽UDPサービスと合成パケットのみ。実機送信、8080の接続変更、本体設定変更、FW更新は行っていない。
