# 独立監査結果

監査日: 2026-10-30 (Asia/Tokyo、初回2026-10-29)。対象: BACKEND-ADAPTER-DESIGN-20261026.mdに基づくxdj-bridge初期実装。実装担当とは別の監査サブエージェントがコードを確認し、独立した回帰テストを追加した。

**結果: 最終テスト74件すべて成功。監査で検出した要修正事項は修正済み。** 保存済みRX3通信を正規化し、可視化とOSCへ配信する経路に加え、画面からの接続先切替、OSC設定変更、設定メニューと表示の安定性、曲名・artistの拡大、再生枠強調、4デッキの表示と出力を確認した。新規の実機参加試験は行っていない。既存のRX3受信を維持した画面確認と、4デッキの合成データ検証を区別している。

## 検証した内容

| 対象 | 結果・根拠 |
|---|---|
| RX3状態 | 保存fixtureと実pcapngに一致。wire 11/12→Deck 1/2、BPM122、実効BPM約137.311、標準playing flag=falseでもplayState4をplayingとして解釈。無効beatはnull。 |
| 入力境界 | magic/port/type/subtype/minimum lengthを検証。不正・切詰めパケットで状態を誤更新しない。pcap/pcapng両endian・timestamp resolution・複数sectionも回帰検証。 |
| 識別・世代 | メディア所有者とslotを含むTrackRef、曲切替・メディア交換・再接続での世代更新、旧メタデータ応答の棄却を確認。 |
| 未知値・鮮度 | null/unknownと最後の値のstaleを分離。BPM、拍、位置、メタデータの利用状態が値の無効化に追従する。 |
| セッション | 明示IF、重複サブネットの起動拒否、観測番号を避ける選択、番号競合時の停止、排他的UDP bindと終了時解放をコード確認。参加パケット全12件とkeepaliveを、既存Python実装から固定したfixtureと照合。 |
| passive | native/alphathetaの受動経路に参加通知・NFS・dbserver要求を実装していないことを確認。alphathetaは公開PcapAdapterを使用。単発フレームエラーで全セッションを停止しない。 |
| WebSocket | 実接続でsnapshot→baseRevision/revision付きdelta→resyncを確認。Host/Origin拒否、既定静的資産の配信も検証。遅い購読者への最新snapshot集約はコード確認。 |
| OSC | 実UDP受信でvalid/quality/fresh、未知値の値パス省略、1200byte上限、各bundleのrevision、周期snapshotを確認。切断直後のcloseでも最終valid=0が届く。 |
| Provider | 有限試行、待機キュー上限、世代ごとの成功/失敗分離を検証。timeout後も未終了処理が同時実行枠を保持し、孤児要求を増やさない。 |
| UI | デモ明示、未知値表示、独立にstaleとなった位置・拍位相の表示、空snapshotでの旧カード除去をコード確認。JavaScript構文検査に成功。描画担当もDOM回帰検証を実施。 |
| 配布 | optional依存を省いたクリーンインストール・ビルド・テストに成功。コンパイル済みruntimeを別フォルダへ展開し、production依存だけでHTTP/UI・4デッキ・OSC・終了時無効化を検証。 |

監査者は接続・OSC切替までの全53件を npm run build && node --test dist/tests/*.test.js で実行し、53 pass / 0 fail / 0 skipを確認した。その後、監査者も最新UI11件と独立4デッキ監査4件を実行し全件成功。親エージェントが最終全suiteを再実行し、74 pass / 0 fail / 0 skipを確認した。監査専用tests/audit.test.tsは元の7件と4デッキの4件を合わせ11件で、媒体交換、機能別利用状態、旧メタデータのOSC無効化、重複IF、Provider timeout、終了時UDP通知、4デッキの共有媒体と独立出力を検証する。接続操作機能ではruntime.test.tsの10件と監査専用runtime-audit.test.tsの5件、4デッキ追加ではfour-deck.test.tsの6件を追加した。

クリーン検証は親エージェントがscripts/validate-release.mjsで最新74件構成のsourceに対して実施した。optional依存を省くnpm ci --offline後のbuild/testは73 pass / 1 skip / 0 fail。配布にはローカル実機キャプチャを含めないため、その任意回帰テスト1件がskipとなる。配布tarを別フォルダへ展開し、production依存のみで4デッキdemoを起動する検証も成功した。HTTP/UI、全4デッキのOSC実UDP valid=1、終了時の全4デッキvalid=0と正常終了を確認した。環境はmacOS arm64 / Node.js26.0.0。Node.js22.18以降を要求するが、今回の実行環境以外のOS・CPU・Node版での配布認証は未実施。

## 接続先切替・OSC設定変更の追加監査

機器モデル、IF、接続方法のプルダウンがPOST APIへ渡り、実際のセッション生成に反映されることを確認した。通常起動は未接続のidleで、選択を変えただけでは参加せず、「接続」で開始する。宣伝見出しとテンポ履歴パネルを取り除き、XDJ受信情報と接続・OSC設定を中心とする画面へ変更した。

| 対象 | 追加した検証 |
|---|---|
| 接続切替 | 旧source終了後に新sourceを作る。新しいsessionIdとsnapshotへ切り替え、旧sourceの遅い状態・エラーはhubへ混入しない。 |
| 接続中の操作 | startupは非同期に進行する。重なる設定変更は409、終了後は503。遅延startupが終了後にhandleを返しても、そのcloseが完了するまでアプリの終了を待つ。 |
| ネットワーク解放 | nativeのabort listenerが先にcloseを開始した場合も、再入したcloseはUDP解放の完了を待つ。mock socketsで3ソケットのcallback完了前に切替へ進まないことを確認。 |
| OSC切替 | 実UDPで旧valid1→より大きいrevisionのvalid0→さらに大きいrevisionの新valid1を確認。同一宛先への再適用でも単調性を維持する。XDJの値・observedAt・quality・freshnessを変更しない。 |
| OSC設定失敗 | 新output生成の失敗を注入し、旧宛先へ復帰することを確認。旧outputは無効化され、新outputはfresh値と後続revisionを持つ。 |
| 設定API境界 | Host/Origin、application/json、4KiB上限を検証。Content-Lengthなしのchunked要求にも上限を適用する。このMacの非loopbackアドレス経由ではGETは成功し、設定POSTは403でmutation回数0。 |
| WebSocket | セッション変更時の最初の通知は完全snapshot。新セッションに旧deckを残さず、旧sourceの遅い通知も送らない。 |

追加監査で、abort起点のcloseへ再入すると元のUDP解放を待たずに戻る競合と、OSC旧宛先の無効化が直前のvalid1と同じrevisionになる問題を検出した。closeのPromise共有と、OSC切替前後のrevision更新で修正し、独立テストで確認した。

親エージェントは実ブラウザでも未接続の初期画面、RX3と実在IFの選択、選択だけでは未接続を保つこと、OSCポート9001への適用と9000への復帰、未適用の接続選択の保持を確認した。console error/warnはなかった。機器への参加は実施していない。

## ハンバーガーメニュー・表示安定化の追加監査

接続先とOSC設定を、初期状態では閉じた右側のnative dialogへ移動した。既存formのDOMとIDを維持し、ハンバーガー・閉じるボタンをtype=buttonとすることで開閉によるsubmitを防ぐ。開閉処理にPOSTや設定の初期化はなく、未適用の入力を保持する。aria-expanded、フォーカス復帰、背景スクロール抑制、100dvh内の内部スクロール、小画面幅の制限をコード確認した。Escapeとモーダル内のフォーカス制御はnative dialogを使用する。

高頻度受信でデッキDOMを毎回取り外す処理を差分反映へ変更し、変わらない文字列・BPM断片・能力・診断を再作成しない。最新状態を50ms単位で集約して描画する。IF一覧はソート・重複除去し、既存optionを再利用する。選択中のIF一覧は更新を保留し、選択操作の終了後に最新の一覧へ反映する。native selectのpopup展開時にfocusがdialogへ移る場合も、pointer/keyboard操作のラッチで更新を保留する。

追加のtests/ui.test.tsを監査者も実行し、6件すべて成功した。デッキDOM・details・focusの保持、受信バーストの描画集約と最新BPM、IF一覧の安定とfocus中の更新保留、メニュー開閉時の未適用入力保持とPOSTなし、WS再接続時のstale復元、native popupのfocus移動中のoption保持を検証する。JavaScript構文検査も成功。linkedomは固定した開発依存のみで、製品ランタイム依存には追加していない。今回のコード監査で追加の要修正所見はなかった。

親エージェントは実ブラウザでも、既存のRX3受信を継続したままメニュー開閉、Escape、未適用入力の保持を確認した。画面確認のために接続やOSC設定を変更していない。

## 接続メッセージ表示の追加監査

デッキの直前で表示・非表示を繰り返していたsession-reasonを除き、接続状態は常設の固定幅76px・高さ24pxの状態バッジへ変更した。理由の原文は折り畳み診断内の「直近の接続メッセージ（過去の記録）」に表示する。非空理由をWS受信時に記憶し、nullでは消去せず、同文は再描画しない。sessionId変更時は記録をリセットする。理由だけの更新でruntimeを再取得しないこともコード確認した。

追加3件を含むUI9件を監査者も実行し、全件成功した。理由とnullの高速交互受信でもデッキ・周辺DOM・状態バッジが安定すること、診断内での理由保持とセッション切替時のリセット、同一描画フレーム内の理由→nullの保持を検証する。JavaScript構文検査も成功し、今回の差分に重大所見はなかった。新規の実機接続やOSC設定変更は行っていない。

親エージェントは実ブラウザで既存のRX3受信を維持し、固定の「受信中」バッジ、旧inline行がないこと、診断を開いた時に状態・en6・直近メッセージを確認できることを検証した。console error/warnはなく、画面プレビューも更新した。

## 曲名拡大・再生枠・4デッキの追加監査

曲名20px・artist16px（狭幅18px・15px）、最大2行と全文tooltipを確認した。枠はfreshかつqualityが既知のplaying/looping/cue_playingだけを強調し、停止・不明・null・staleでは解除する。色はDOMの到着順ではなくlogicalDeckの1〜4に固定する。4デッキの順不同到着・欠落・再接続でも、既存カード・details・focusとメタデータを維持するUI回帰が成功した。

独立監査で、AZのsource番号1より先に4/3/2の状態が届くと共有媒体ownerが分裂し、USB交換時に旧title/artistを解除できない不具合を再現した。後着のownerを実際に観測した時点で既存の未解決参照を統一し、旧要求の世代を無効化する修正を確認した。未確認の番号範囲だけで外部CDJの媒体を同じ本体へ吸収しないことも検証した。

追加の独立4件では、後着sourceとUSB交換での旧メタデータ棄却、公開ID az1〜az4のOSCルーティング、deck4だけのstale/復帰、deck3だけの曲切替、外部source保持を確認した。実装担当の4デッキ6件は合成rawパケット480件、4台のCDJ、混在2+4デッキ、設定検証、runtime、WS/実UDPへの配信を検証する。4デッキのデモは明示指定時だけで、RX3の既定2デッキと未取得メタデータを維持する。AZの実機対応は未検証のままとする。

親エージェントのブラウザQAでは、1200×1000で4デッキが2列×2段、390×844で縦積みとなり横overflowがないこと、fresh再生中のdeck1/3だけに色枠が付くことを確認した。監査者も合成データのデスクトップ画像を確認した。合成の曲名・artistを含む表示QAは、機器からのメタデータ直接取得の実証には含めない。

最終更新時は、親エージェントが8080の実行プロセスとruntimeを読み、未接続・接続処理なし・en6利用不可のエラー・OSC無効を確認した。その後、8080プロセスを最新版へ更新し、RX3/en6の選択を保持したidle・OSC無効で起動した。実ブラウザでメニュー閉・未接続・console error/warnなしを確認した。実機への接続やOSC有効化は行っていない。実装・監査サブエージェントは受信プロセスと実機設定を変更していない。

## 監査で検出して修正した事項

- コンパイル後の静的資産パス不一致によるUIの404、空snapshot後の旧カード残留、機能単独のstale表示漏れ。
- 分割OSC bundleの後続にrevisionが付かない問題と、終了時にpendingの無効化通知が破棄される問題。全bundleにヘッダを反復し、終了時flushの完了を待つ。
- 有効beatの受信、位置ストリームの途絶、媒体交換・切断に対してCapability利用状態が追従しない問題。検証履歴を保持しながら現在の利用状態を更新する。
- 秒切捨ての曲長によって最後の999msの絶対位置が不正扱いとなる問題。
- ライブ終了時の人工的な60秒加算、状態通知から観測した番号が番号選択に反映されない問題、開始後のIF重複・IP/netmask変更の再評価不足。
- 空白を含むworkspaceパスで配布スクリプトが失敗する問題と、optionalライブラリを省くと型解決がビルドを妨げる問題。

## 実装範囲と残る検証

RX3の曲名・アーティストを直接取得する標準Provider、AZのNFS/dbserver Provider、波形・beat grid・cue、機種別MixerDecoder、自動再参加は未実装。MetadataProvider差込口と有限スケジューラを提供する。未取得値はnullを維持し、曲名の直接取得達成やAZ全機能対応を表示しない。

native UDPは送信元IPv4を固定する。Node標準APIにmacOSのIP_BOUND_IFがないため、サブネットが重なるIFを起動時と稼働中に拒否する。厳密なIF束縛が必要な受動監視では、明示IFのpcapを使用する。ライブ値と実機操作の照合、実機番号競合・USB交換・ケーブル抜差し、AZの4デッキと各機能は後続の実機受入対象である。

RX3 Toolkit、本体モジュール、ファームウェアへの変更は行っていない。DJのUSBデータベースの事前コピーを運用要件に追加していない。
