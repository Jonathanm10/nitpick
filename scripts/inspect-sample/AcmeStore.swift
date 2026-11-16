// Acme Store, a fictional SwiftUI app that Inspect's fixtures come from
// (fixtures.sh). It holds no inspector code: nitpick only adds launch
// environment. Each screen covers something a real app's tree does:
//
//   shop       product rows in a VStack in a ScrollView in a NavigationStack,
//              fonts set through a view modifier, buttons styled by enums
//   scrolled   the same, scrolled down by 100 points
//   browse     a LazyVGrid of category tiles
//   sheet      a medium-height sheet over the tab bar
//   cover      a full-screen cover over the tab bar
//
// ACME_SCREEN picks the screen at launch; shop when unset. The tests assert
// the values written here, so changing one means regenerating the fixtures.
import SwiftUI

enum Palette {
    static let accent = Color(red: 0x5B / 255, green: 0x4C / 255, blue: 0xF0 / 255)
    static let accentSoft = Color(red: 0xED / 255, green: 0xEB / 255, blue: 0xFF / 255)
    static let card = Color(red: 0xF4 / 255, green: 0xF1 / 255, blue: 0xEA / 255)
    static let tile = Color(red: 0xFF / 255, green: 0x6B / 255, blue: 0x35 / 255)
    static let ink = Color(red: 0x1F / 255, green: 0x29 / 255, blue: 0x37 / 255)
    static let muted = Color(red: 0x6B / 255, green: 0x72 / 255, blue: 0x80 / 255)
}

/** The app's type scale, applied through `acmeType`, never `.font` directly. */
enum AcmeType {
    case title, headline, body, caption, button

    var font: Font {
        switch self {
        case .title: .custom("AvenirNext-DemiBold", size: 26)
        case .headline: .system(size: 17, weight: .semibold)
        case .body: .system(size: 15)
        case .caption: .system(size: 12, weight: .medium)
        case .button: .system(size: 16, weight: .bold)
        }
    }

    var tracking: CGFloat {
        switch self {
        case .caption: 1.2
        case .title: 0.4
        default: 0
        }
    }

    var color: Color {
        switch self {
        case .caption: Palette.muted
        default: Palette.ink
        }
    }
}

struct AcmeTypeModifier: ViewModifier {
    let type: AcmeType

    func body(content: Content) -> some View {
        content
            .font(type.font)
            .tracking(type.tracking)
            .foregroundStyle(type.color)
    }
}

extension View {
    func acmeType(_ type: AcmeType) -> some View {
        modifier(AcmeTypeModifier(type: type))
    }
}

/** The design system's button, configured only through its enums. */
struct AcmeButton: View {
    enum Style { case primary, secondary }
    enum Size { case regular, compact }

    let title: String
    let style: Style
    let size: Size

    var body: some View {
        Button {} label: {
            Text(title)
        }
        .buttonStyle(AcmeButtonStyle(style: style, size: size))
    }
}

struct AcmeButtonStyle: ButtonStyle {
    let style: AcmeButton.Style
    let size: AcmeButton.Size

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            // The innermost style wins: this one over acmeType's ink.
            .foregroundStyle(style == .primary ? Color.white : Palette.accent)
            .acmeType(.button)
            .padding(.horizontal, size == .regular ? 24 : 16)
            .padding(.vertical, size == .regular ? 14 : 8)
            .background(
                RoundedRectangle(cornerRadius: size == .regular ? 14 : 10)
                    .fill(style == .primary ? Palette.accent : Palette.accentSoft)
            )
    }
}

struct Product: Identifiable {
    let id: String
    let price: String
    let symbol: String
}

let products = [
    Product(id: "Trail Runner 3", price: "CHF 129.00", symbol: "figure.run"),
    Product(id: "Weekender Bag", price: "CHF 89.00", symbol: "bag.fill"),
    Product(id: "Studio Headphones", price: "CHF 249.00", symbol: "headphones"),
    Product(id: "Pocket Camera", price: "CHF 399.00", symbol: "camera.fill"),
    Product(id: "City Bike", price: "CHF 899.00", symbol: "bicycle"),
    Product(id: "Desk Lamp", price: "CHF 59.00", symbol: "lamp.desk.fill"),
    Product(id: "Rain Jacket", price: "CHF 179.00", symbol: "cloud.rain.fill"),
]

struct ProductRow: View {
    let product: Product

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: product.symbol)
                .font(.system(size: 24))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(RoundedRectangle(cornerRadius: 12).fill(Palette.tile))
            VStack(alignment: .leading, spacing: 4) {
                Text(product.id)
                    .acmeType(.headline)
                Text(product.price.uppercased())
                    .acmeType(.caption)
            }
            Spacer()
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 18).fill(Palette.card))
    }
}

struct ShopView: View {
    let scrolled: Bool
    @State private var position = ScrollPosition(edge: .top)
    private let launch = Date()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("New this week")
                        .acmeType(.title)
                    Text("Seven things we like, picked by the Acme team.")
                        .acmeType(.body)
                    // A live timer is laid out by TextKit 2, unlike other text.
                    HStack(spacing: 6) {
                        Text("Free shipping ends in")
                            .acmeType(.caption)
                        Text(timerInterval: launch...launch.addingTimeInterval(15 * 60))
                            .acmeType(.caption)
                    }
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity)
                    .background(Palette.accentSoft)
                    ForEach(products) { product in
                        ProductRow(product: product)
                    }
                    AcmeButton(title: "Check out", style: .primary, size: .regular)
                }
                .padding(.horizontal, 20)
            }
            .scrollPosition($position)
            .navigationTitle("Shop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Image(systemName: "cart")
                }
            }
            .onAppear {
                if scrolled { position.scrollTo(y: 100) }
            }
        }
    }
}

struct Category: Identifiable {
    let id: String
    let symbol: String
}

let categories = [
    Category(id: "Running", symbol: "figure.run"),
    Category(id: "Travel", symbol: "airplane"),
    Category(id: "Audio", symbol: "headphones"),
    Category(id: "Photo", symbol: "camera.fill"),
    Category(id: "Cycling", symbol: "bicycle"),
    Category(id: "Home", symbol: "house.fill"),
]

struct CategoryTile: View {
    let category: Category

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: category.symbol)
                .font(.system(size: 28))
                .foregroundStyle(Palette.accent)
            Text(category.id)
                .acmeType(.headline)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 120)
        .background(RoundedRectangle(cornerRadius: 20).fill(Palette.card))
    }
}

struct BrowseView: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(
                    columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                    spacing: 16
                ) {
                    ForEach(categories) { category in
                        CategoryTile(category: category)
                    }
                }
                .padding(20)
            }
            .navigationTitle("Browse")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct CartSheet: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Your cart")
                .acmeType(.title)
            Text("2 items · CHF 218.00")
                .acmeType(.body)
            AcmeButton(title: "Pay now", style: .primary, size: .compact)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .presentationDetents([.medium])
    }
}

struct WelcomeCover: View {
    var body: some View {
        VStack(spacing: 20) {
            Text("Welcome to Acme Store")
                .acmeType(.title)
            Text("Sign in to keep your cart, your wish list and your orders on every device you use.")
                .acmeType(.body)
                .lineSpacing(6)
                .multilineTextAlignment(.center)
            AcmeButton(title: "Start shopping", style: .secondary, size: .regular)
        }
        .padding(32)
    }
}

enum Screen: String {
    case shop, scrolled, browse, sheet, cover
}

enum Tab {
    case shop, browse
}

struct RootView: View {
    let screen: Screen
    @State private var tab: Tab
    @State private var showsSheet = false
    @State private var showsCover = false

    init(screen: Screen) {
        self.screen = screen
        _tab = State(initialValue: screen == .browse ? .browse : .shop)
    }

    var body: some View {
        TabView(selection: $tab) {
            SwiftUI.Tab("Shop", systemImage: "bag", value: Tab.shop) {
                ShopView(scrolled: screen == .scrolled)
            }
            SwiftUI.Tab("Browse", systemImage: "square.grid.2x2", value: Tab.browse) {
                BrowseView()
            }
        }
        .sheet(isPresented: $showsSheet) { CartSheet() }
        .fullScreenCover(isPresented: $showsCover) { WelcomeCover() }
        .onAppear {
            showsSheet = screen == .sheet
            showsCover = screen == .cover
        }
    }
}

@main
struct AcmeStoreApp: App {
    var body: some Scene {
        WindowGroup {
            RootView(screen: Screen(rawValue: ProcessInfo.processInfo.environment["ACME_SCREEN"] ?? "") ?? .shop)
        }
    }
}
