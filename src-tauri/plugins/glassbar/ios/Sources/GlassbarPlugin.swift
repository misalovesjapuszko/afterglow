// Native Liquid Glass chrome for Afterglow on iPhone: a floating tab bar and an Apple Music
// style mini player, drawn by UIKit on top of the web view so the real iOS 26+ glass
// (UIGlassEffect) refracts whatever scrolls underneath. Older iOS gets a dark blur.
//
// The web UI drives it with plugin:glassbar|configure / select / track / show.
// Taps go back to the page by calling window.__glassbar(name, value).

import SwiftRs
import Tauri
import UIKit
import WebKit

struct GlassTab: Decodable {
  let id: String
  let title: String
  let icon: String
}

class ConfigureArgs: Decodable {
  let tabs: [GlassTab]
  let selected: String?
}

class SelectArgs: Decodable {
  let id: String
}

class TrackArgs: Decodable {
  let title: String?
  let artist: String?
  let art: String?
  let playing: Bool?
}

class ShowArgs: Decodable {
  let visible: Bool
}

private let accent = UIColor(red: 0.545, green: 0.361, blue: 0.965, alpha: 1) // #8b5cf6, same purple as the website

/// A rounded glass panel: UIGlassEffect on iOS 26+, a dark blur before that.
private func makeGlass(cornerRadius: CGFloat) -> UIVisualEffectView {
  var effect: UIVisualEffect = UIBlurEffect(style: .systemChromeMaterialDark)
  #if compiler(>=6.2)
  if #available(iOS 26.0, *) {
    let glass = UIGlassEffect(style: .regular)
    glass.isInteractive = true
    effect = glass
  }
  #endif
  let v = UIVisualEffectView(effect: effect)
  v.translatesAutoresizingMaskIntoConstraints = false
  v.layer.cornerRadius = cornerRadius
  v.layer.cornerCurve = .continuous
  v.clipsToBounds = true
  return v
}

private func pin(_ v: UIView, to p: UIView, inset: CGFloat = 0) {
  NSLayoutConstraint.activate([
    v.leadingAnchor.constraint(equalTo: p.leadingAnchor, constant: inset),
    v.trailingAnchor.constraint(equalTo: p.trailingAnchor, constant: -inset),
    v.topAnchor.constraint(equalTo: p.topAnchor, constant: inset),
    v.bottomAnchor.constraint(equalTo: p.bottomAnchor, constant: -inset),
  ])
}

// MARK: - Tab bar

final class GlassTabBar: UIView {
  var onTap: ((String) -> Void)?
  private let glass = makeGlass(cornerRadius: 31)
  private let stack = UIStackView()
  private let pill = UIView()
  private var buttons: [UIButton] = []
  private var ids: [String] = []
  private var selectedId: String?

  override init(frame: CGRect) {
    super.init(frame: frame)
    translatesAutoresizingMaskIntoConstraints = false
    overrideUserInterfaceStyle = .dark
    addSubview(glass)
    pin(glass, to: self)
    pill.backgroundColor = UIColor.white.withAlphaComponent(0.14)
    pill.layer.cornerRadius = 25
    pill.layer.cornerCurve = .continuous
    pill.alpha = 0
    glass.contentView.addSubview(pill)
    stack.axis = .horizontal
    stack.distribution = .fillEqually
    stack.translatesAutoresizingMaskIntoConstraints = false
    glass.contentView.addSubview(stack)
    pin(stack, to: glass.contentView, inset: 6)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  func setTabs(_ tabs: [GlassTab]) {
    buttons.forEach { $0.removeFromSuperview() }
    buttons = []
    ids = tabs.map { $0.id }
    for (i, t) in tabs.enumerated() {
      var c = UIButton.Configuration.plain()
      c.image = UIImage(systemName: t.icon, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold))
      c.title = t.title
      c.imagePlacement = .top
      c.imagePadding = 3
      c.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 0, bottom: 2, trailing: 0)
      c.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attrs in
        var a = attrs
        a.font = UIFont.systemFont(ofSize: 10, weight: .semibold)
        return a
      }
      let b = UIButton(configuration: c)
      b.tag = i
      b.addTarget(self, action: #selector(tapped(_:)), for: .touchUpInside)
      stack.addArrangedSubview(b)
      buttons.append(b)
    }
    select(selectedId, animated: false)
  }

  @objc private func tapped(_ b: UIButton) {
    guard b.tag < ids.count else { return }
    let id = ids[b.tag]
    UISelectionFeedbackGenerator().selectionChanged()
    select(id, animated: true)
    onTap?(id)
  }

  func select(_ id: String?, animated: Bool) {
    selectedId = id
    let idx = id.flatMap { ids.firstIndex(of: $0) }
    for (i, b) in buttons.enumerated() {
      b.configuration?.baseForegroundColor = i == idx ? accent : UIColor.white.withAlphaComponent(0.88)
    }
    if animated {
      UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.78, initialSpringVelocity: 0.4, options: [.beginFromCurrentState]) {
        self.placePill()
      }
    } else {
      placePill()
    }
  }

  private func placePill() {
    guard let id = selectedId, let i = ids.firstIndex(of: id), i < buttons.count else {
      pill.alpha = 0
      return
    }
    glass.contentView.layoutIfNeeded()
    let b = buttons[i]
    pill.frame = b.convert(b.bounds, to: glass.contentView).insetBy(dx: 1, dy: 0)
    pill.alpha = 1
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if let id = selectedId, let i = ids.firstIndex(of: id), i < buttons.count {
      let b = buttons[i]
      pill.frame = b.convert(b.bounds, to: glass.contentView).insetBy(dx: 1, dy: 0)
    }
  }
}

// MARK: - Mini player

final class GlassMiniPlayer: UIView {
  var onAction: ((String) -> Void)?
  private let glass = makeGlass(cornerRadius: 28)
  private let art = UIImageView()
  private let titleLabel = UILabel()
  private let artistLabel = UILabel()
  private let playButton = UIButton(type: .system)
  private let nextButton = UIButton(type: .system)
  private var artURL: String?

  override init(frame: CGRect) {
    super.init(frame: frame)
    translatesAutoresizingMaskIntoConstraints = false
    overrideUserInterfaceStyle = .dark
    addSubview(glass)
    pin(glass, to: self)

    art.translatesAutoresizingMaskIntoConstraints = false
    art.contentMode = .scaleAspectFill
    art.clipsToBounds = true
    art.layer.cornerRadius = 9
    art.layer.cornerCurve = .continuous
    art.backgroundColor = UIColor.white.withAlphaComponent(0.08)

    titleLabel.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
    titleLabel.textColor = .white
    artistLabel.font = UIFont.systemFont(ofSize: 13, weight: .regular)
    artistLabel.textColor = UIColor.white.withAlphaComponent(0.6)
    let texts = UIStackView(arrangedSubviews: [titleLabel, artistLabel])
    texts.axis = .vertical
    texts.spacing = 1
    texts.translatesAutoresizingMaskIntoConstraints = false

    for (b, icon, sel) in [(playButton, "play.fill", #selector(togglePlay)), (nextButton, "forward.fill", #selector(skip))] {
      b.translatesAutoresizingMaskIntoConstraints = false
      b.tintColor = .white
      b.setImage(UIImage(systemName: icon, withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .bold)), for: .normal)
      b.addTarget(self, action: sel, for: .touchUpInside)
    }

    let c = glass.contentView
    [art, texts, playButton, nextButton].forEach { c.addSubview($0) }
    NSLayoutConstraint.activate([
      art.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 8),
      art.centerYAnchor.constraint(equalTo: c.centerYAnchor),
      art.widthAnchor.constraint(equalToConstant: 40),
      art.heightAnchor.constraint(equalToConstant: 40),
      texts.leadingAnchor.constraint(equalTo: art.trailingAnchor, constant: 11),
      texts.centerYAnchor.constraint(equalTo: c.centerYAnchor),
      texts.trailingAnchor.constraint(lessThanOrEqualTo: playButton.leadingAnchor, constant: -6),
      nextButton.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -8),
      nextButton.centerYAnchor.constraint(equalTo: c.centerYAnchor),
      nextButton.widthAnchor.constraint(equalToConstant: 44),
      nextButton.heightAnchor.constraint(equalToConstant: 44),
      playButton.trailingAnchor.constraint(equalTo: nextButton.leadingAnchor),
      playButton.centerYAnchor.constraint(equalTo: c.centerYAnchor),
      playButton.widthAnchor.constraint(equalToConstant: 44),
      playButton.heightAnchor.constraint(equalToConstant: 44),
    ])
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(open)))
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  @objc private func open() { onAction?("open") }
  @objc private func togglePlay() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    onAction?("toggle")
  }
  @objc private func skip() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    onAction?("next")
  }

  func update(_ t: TrackArgs) {
    let newTitle = t.title ?? ""
    if newTitle != titleLabel.text {
      UIView.transition(with: self, duration: 0.3, options: .transitionCrossDissolve) {
        self.titleLabel.text = newTitle
        self.artistLabel.text = t.artist ?? ""
      }
    } else {
      artistLabel.text = t.artist ?? ""
    }
    let icon = (t.playing ?? false) ? "pause.fill" : "play.fill"
    playButton.setImage(UIImage(systemName: icon, withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .bold)), for: .normal)
    loadArt(t.art)
  }

  private func loadArt(_ s: String?) {
    guard s != artURL else { return }
    artURL = s
    guard let s = s, !s.isEmpty, let url = URL(string: s) else {
      art.image = nil
      return
    }
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let data = data, let img = UIImage(data: data) else { return }
      DispatchQueue.main.async {
        guard let self = self, self.artURL == s else { return }
        UIView.transition(with: self.art, duration: 0.35, options: .transitionCrossDissolve) { self.art.image = img }
      }
    }.resume()
  }
}

// MARK: - Plugin

class GlassbarPlugin: Plugin {
  private weak var webView: WKWebView?
  private var tabBar: GlassTabBar?
  private var mini: GlassMiniPlayer?
  private var visible = false
  private var hasTrack = false

  public override func load(webview: WKWebView) {
    webView = webview
  }

  private func ensureViews() {
    guard tabBar == nil, let wv = webView, let host = wv.superview ?? wv.window else { return }
    let tb = GlassTabBar()
    let mp = GlassMiniPlayer()
    host.addSubview(mp)
    host.addSubview(tb)
    let safe = host.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      tb.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: 14),
      tb.trailingAnchor.constraint(equalTo: host.trailingAnchor, constant: -14),
      tb.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: 6),
      tb.heightAnchor.constraint(equalToConstant: 62),
      mp.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: 14),
      mp.trailingAnchor.constraint(equalTo: host.trailingAnchor, constant: -14),
      mp.bottomAnchor.constraint(equalTo: tb.topAnchor, constant: -8),
      mp.heightAnchor.constraint(equalToConstant: 56),
    ])
    tb.onTap = { [weak self] id in self?.emit("tab", id) }
    mp.onAction = { [weak self] a in self?.emit("mini", a) }
    tabBar = tb
    mini = mp
    apply(animated: false)
  }

  private func emit(_ name: String, _ value: String) {
    guard let data = try? JSONSerialization.data(withJSONObject: [name, value]),
          let args = String(data: data, encoding: .utf8) else { return }
    webView?.evaluateJavaScript("window.__glassbar && window.__glassbar(...\(args))", completionHandler: nil)
  }

  private func apply(animated: Bool) {
    let showTabs = visible
    let showMini = visible && hasTrack
    let change = {
      self.tabBar?.alpha = showTabs ? 1 : 0
      self.tabBar?.transform = showTabs ? .identity : CGAffineTransform(translationX: 0, y: 40)
      self.mini?.alpha = showMini ? 1 : 0
      self.mini?.transform = showMini ? .identity : CGAffineTransform(translationX: 0, y: 30).scaledBy(x: 0.96, y: 0.96)
    }
    tabBar?.isUserInteractionEnabled = showTabs
    mini?.isUserInteractionEnabled = showMini
    if animated {
      UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0, options: [.beginFromCurrentState], animations: change)
    } else {
      change()
    }
  }

  @objc public func configure(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ConfigureArgs.self)
    DispatchQueue.main.async {
      self.ensureViews()
      self.tabBar?.setTabs(args.tabs)
      self.tabBar?.select(args.selected, animated: false)
      invoke.resolve(["ok": self.tabBar != nil])
    }
  }

  @objc public func tab(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SelectArgs.self)
    DispatchQueue.main.async {
      self.tabBar?.select(args.id, animated: true)
      invoke.resolve()
    }
  }

  @objc public func track(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(TrackArgs.self)
    DispatchQueue.main.async {
      self.mini?.update(args)
      let had = self.hasTrack
      self.hasTrack = !(args.title ?? "").isEmpty
      if had != self.hasTrack { self.apply(animated: true) }
      invoke.resolve()
    }
  }

  @objc public func show(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShowArgs.self)
    DispatchQueue.main.async {
      self.ensureViews()
      if self.visible != args.visible {
        self.visible = args.visible
        self.apply(animated: true)
      }
      invoke.resolve()
    }
  }
}

@_cdecl("init_plugin_glassbar")
func initPlugin() -> Plugin {
  return GlassbarPlugin()
}
