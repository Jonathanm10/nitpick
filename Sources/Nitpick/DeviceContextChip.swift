import NitpickCore
import SwiftUI

/// The session's Device Context at a glance: the active device, shown as the
/// leading control of the `SessionTopBar` pill. Sized to the pill's own type
/// scale (13pt), so it carries no capsule fill of its own — the pill is the
/// surface — just a subtle hover highlight. Its tap opens the searchable
/// device list directly: with accessibility gone from the popover (ADR-0009)
/// there is nothing left to nest, so the chip and the no-session setup group
/// share one list.
struct DeviceContextChip: View {
    @Bindable var model: AppModel
    @State private var isPopoverPresented = false
    @State private var isHovering = false

    var body: some View {
        Button {
            isPopoverPresented = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "iphone")
                    .font(.system(size: 13))
                    .foregroundStyle(NitpickTheme.secondaryText)
                Text(deviceName)
                    .font(NitpickTheme.emphasis)
                    .lineLimit(1)
                Text("· \(osName)")
                    .font(NitpickTheme.secondary)
                    .foregroundStyle(NitpickTheme.secondaryText)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(NitpickTheme.secondaryText)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .contentShape(RoundedRectangle(cornerRadius: NitpickTheme.radiusSmall))
        }
        .buttonStyle(.plain)
        .background(
            isHovering ? NitpickTheme.hover : .clear,
            in: RoundedRectangle(cornerRadius: NitpickTheme.radiusSmall)
        )
        .onHover { isHovering = $0 }
        .accessibilityLabel(accessibilityLabel)
        .popover(isPresented: $isPopoverPresented, arrowEdge: .bottom) {
            DeviceList(model: model, isPresented: $isPopoverPresented)
        }
        .motionPressFeedback()
    }

    private var deviceName: String {
        model.selectedDevice?.name ?? model.reviewDevice?.name ?? "No device selected"
    }

    private var osName: String {
        model.selectedDevice?.osName ?? model.reviewDevice?.osName ?? "runtime unknown"
    }

    private var accessibilityLabel: Text {
        Text("Device Context, \(deviceName) — \(osName)")
    }
}

/// The no-session setup group's device control (issue 04): a button showing
/// the current device that opens the shared searchable `DeviceList`. Mirrors
/// `AssigneePicker`'s button-plus-popover idiom.
struct DevicePicker: View {
    @Bindable var model: AppModel
    @State private var showingList = false

    var body: some View {
        Button {
            showingList = true
        } label: {
            HStack(spacing: 8) {
                Text(currentLabel)
                    .foregroundStyle(model.selectedDevice == nil ? NitpickTheme.secondaryText : Color.primary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(NitpickTheme.secondaryText)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .nitpickField(minHeight: 34)
        .frame(maxWidth: 320, alignment: .leading)
        .disabled(model.isBusy)
        .motionPressFeedback()
        .popover(isPresented: $showingList, arrowEdge: .bottom) {
            DeviceList(model: model, isPresented: $showingList)
        }
    }

    private var currentLabel: String {
        guard let device = model.selectedDevice else { return "No device selected" }
        return "\(device.name) — \(device.osName)"
    }
}

/// The Xcode-style searchable device list shared by the no-session setup
/// group and the in-session chip (PRD): a text filter, a **Recent** section
/// (the devices actually reviewed on), and the full device list below.
/// Sections both persist while filtering — at nitpick's device counts a
/// device appearing in both is fine (PRD story 6). Runtime-missing devices
/// render disabled in All and are omitted from Recent. The selection
/// binding lives here so switching behaves identically from either entry
/// point: mid-session it relaunches the Build and reverts on failure.
struct DeviceList: View {
    @Bindable var model: AppModel
    @Binding var isPresented: Bool
    @State private var query = ""

    /// The designer's Recent devices, unfiltered — present-and-available in
    /// MRU order. Drives whether the Recent section exists at all: absent
    /// only on a first run (or a cleaned-up machine) with no history.
    private var recentDevices: [SimulatorDevice] {
        model.recentDevices.resolved(among: model.devices)
    }

    private var recent: [SimulatorDevice] {
        filtered(recentDevices)
    }

    private var all: [SimulatorDevice] {
        filtered(model.devices)
    }

    /// Matches device name and OS version, so the designer can narrow by
    /// either ("17 Pro" or "26.4") — PRD story 5.
    private func filtered(_ devices: [SimulatorDevice]) -> [SimulatorDevice] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return devices }
        return devices.filter {
            $0.name.localizedCaseInsensitiveContains(trimmed)
                || $0.osName.localizedCaseInsensitiveContains(trimmed)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            TextField("Search devices", text: $query)
                .textFieldStyle(.roundedBorder)
                .padding(10)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    // Recent and All both stay visible while filtering (PRD
                    // story 6): the section persists whenever the designer
                    // has recents; the filter only narrows its rows.
                    if !recentDevices.isEmpty {
                        sectionHeader("Recent")
                        ForEach(recent) { row(for: $0) }
                    }
                    sectionHeader("All")
                    ForEach(all) { row(for: $0) }
                }
            }
            .frame(maxHeight: 280)
        }
        .frame(width: 320)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(NitpickTheme.secondaryText)
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(for device: SimulatorDevice) -> some View {
        Button {
            select(device)
        } label: {
            HStack {
                Text(label(for: device))
                    .lineLimit(1)
                    .foregroundStyle(device.isRuntimeAvailable ? Color.primary : NitpickTheme.secondaryText)
                Spacer(minLength: 8)
                if device.id == model.selectedDeviceID {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // A runtime-missing device stays visible but unselectable (PRD
        // story 7): the designer sees why they can't pick it.
        .disabled(!device.isRuntimeAvailable)
    }

    private func label(for device: SimulatorDevice) -> String {
        device.isRuntimeAvailable
            ? "\(device.name) — \(device.osName)"
            : "\(device.name) — \(device.osName) (runtime missing)"
    }

    /// Mid-session, choosing a device is a switch — the model relaunches the
    /// Build and reverts the selection if it fails; otherwise it is a plain
    /// preselection. Same code path from both entry points.
    private func select(_ device: SimulatorDevice) {
        query = ""
        isPresented = false
        if model.isReviewing {
            Task { await model.switchDevice(to: device.id) }
        } else {
            model.selectedDeviceID = device.id
        }
    }
}
