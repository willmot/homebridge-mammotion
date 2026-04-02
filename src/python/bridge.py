#!/usr/bin/env python3
"""Persistent JSONL bridge between Homebridge and PyMammotion."""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from pymammotion.mammotion.devices.mammotion import Mammotion
from pymammotion.proto import RptAct, RptInfoType
from pymammotion.utility.constant.device_constant import WorkMode, device_mode


class Bridge:
    def __init__(self) -> None:
        self.mammotion = Mammotion()
        self.email: str | None = None
        self.password: str | None = None
        self.area_name_fallbacks: dict[str, list[str]] = {}
        self._area_id_map: dict[str, dict[int, int]] = {}
        self._next_area_refresh_at: dict[str, float] = {}
        self._next_plan_refresh_at: dict[str, float] = {}

    async def handle(self, method: str, params: dict[str, Any]) -> Any:
        if method == "init":
            return await self._init(params)
        if method == "list_devices":
            return await self._list_devices()
        if method == "poll":
            return await self._poll()
        if method == "command":
            return await self._command(params)
        if method == "shutdown":
            await self.mammotion.stop()
            return {"shutdown": True}
        raise ValueError(f"Unknown method: {method}")

    async def _init(self, params: dict[str, Any]) -> dict[str, bool]:
        email = str(params.get("email", "")).strip()
        password = str(params.get("password", "")).strip()
        if not email or not password:
            raise ValueError("Missing email or password")

        self.email = email
        self.password = password
        raw_fallbacks = params.get("areaNameFallbacks", {})
        parsed_fallbacks: dict[str, list[str]] = {}
        if isinstance(raw_fallbacks, dict):
            for key, value in raw_fallbacks.items():
                if not isinstance(key, str):
                    continue
                if not isinstance(value, list):
                    continue
                names = [str(item).strip() for item in value if str(item).strip()]
                if names:
                    parsed_fallbacks[key] = names
        self.area_name_fallbacks = parsed_fallbacks
        await self.mammotion.login_and_initiate_cloud(email, password)
        return {"ready": True}

    async def _list_devices(self) -> list[dict[str, Any]]:
        devices = []
        for manager in self.mammotion.device_manager.devices.values():
            name = manager.name
            serial = name.split("-", 1)[-1] if "-" in name else name
            model = manager.state.mower_state.model or manager.state.mower_state.product_key
            devices.append(
                {
                    "name": name,
                    "iotId": manager.iot_id,
                    "model": model,
                    "serialNumber": serial,
                }
            )

        devices.sort(key=lambda item: item["name"])
        return devices

    async def _poll(self) -> list[dict[str, Any]]:
        states = []
        now = asyncio.get_running_loop().time()
        for manager in self.mammotion.device_manager.devices.values():
            device_name = manager.name
            # Best effort state refresh from the mower before we read cached state.
            try:
                await self._request_iot_sync(device_name)
            except Exception:
                pass

            map_area_names = list(getattr(manager.state.map, "area_name", []) or [])
            map_areas = dict(getattr(manager.state.map, "area", {}) or {})
            map_plans = dict(getattr(manager.state.map, "plan", {}) or {})

            if now >= self._next_area_refresh_at.get(device_name, 0):
                try:
                    # Keep requesting map + names until map metadata is hydrated.
                    await self.mammotion.start_map_sync(device_name)
                except Exception as ex:
                    self._debug(f"{device_name}: start_map_sync failed: {ex}")
                try:
                    await self._send_command(device_name, "get_all_boundary_hash_list", sub_cmd=0)
                except Exception as ex:
                    self._debug(f"{device_name}: get_all_boundary_hash_list failed: {ex}")
                try:
                    await self._send_command(device_name, "get_area_name_list", device_id=manager.iot_id)
                except Exception as ex:
                    self._debug(f"{device_name}: get_area_name_list failed: {ex}")

                # Retry quickly while no area metadata is available, otherwise back off.
                if len(map_areas) == 0 and len(map_area_names) == 0:
                    self._next_area_refresh_at[device_name] = now + 20.0
                else:
                    self._next_area_refresh_at[device_name] = now + 120.0

            if now >= self._next_plan_refresh_at.get(device_name, 0):
                try:
                    await self.mammotion.start_schedule_sync(device_name)
                except Exception as ex:
                    self._debug(f"{device_name}: start_schedule_sync failed: {ex}")

                if len(map_plans) == 0:
                    self._next_plan_refresh_at[device_name] = now + 20.0
                else:
                    self._next_plan_refresh_at[device_name] = now + 300.0

            plan_names = []
            for plan in map_plans.values():
                task_name = str(getattr(plan, "task_name", "")).strip()
                job_name = str(getattr(plan, "job_name", "")).strip()
                if task_name or job_name:
                    plan_names.append(task_name or job_name)

            fallback_names = self._configured_area_names(device_name)
            self._debug(
                f"{device_name}: map areas={len(map_areas)} area_names={len(map_area_names)} "
                f"zone_hashs={len(list(getattr(getattr(manager.state, 'work', None), 'zone_hashs', []) or []))} "
                f"plans={len(map_plans)} plan_names={plan_names} fallback_names={fallback_names}"
            )

            states.append(self._to_state(device_name, manager.state))

        states.sort(key=lambda item: item["name"])
        return states

    async def _command(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "")).strip()
        action = str(params.get("action", "")).strip()
        if not name or not action:
            raise ValueError("Missing name or action")

        manager = self.mammotion.get_device_by_name(name)
        mode = manager.state.report_data.dev.sys_status
        charge_state = manager.state.report_data.dev.charge_state

        if action == "start":
            await self._start(name, mode)
        elif action == "pause":
            await self._pause(name, mode)
        elif action == "dock":
            await self._dock(name, mode, charge_state)
        elif action == "cancel":
            await self._cancel(name, mode)
        else:
            raise ValueError(f"Unsupported action: {action}")

        await self._request_iot_sync(name)
        # Give device/state handlers a brief moment to apply updates.
        await asyncio.sleep(0.15)
        return self._to_state(name, self.mammotion.get_device_by_name(name).state)

    async def _send_command(self, name: str, command: str, **kwargs: Any) -> None:
        await self.mammotion.send_command_with_args(name, command, **kwargs)

    async def _start(self, name: str, mode: int | None) -> None:
        if mode == WorkMode.MODE_WORKING:
            return
        if mode == WorkMode.MODE_RETURNING:
            await self._send_command(name, "cancel_return_to_dock")
            await self._send_command(name, "query_generate_route_information")
            await self._send_command(name, "start_job")
            return
        if mode == WorkMode.MODE_PAUSE:
            await self._send_command(name, "resume_execute_task")
            return

        await self._send_command(name, "query_generate_route_information")
        await self._send_command(name, "start_job")

    async def _pause(self, name: str, mode: int | None) -> None:
        if mode == WorkMode.MODE_WORKING:
            await self._send_command(name, "pause_execute_task")
        elif mode == WorkMode.MODE_RETURNING:
            await self._send_command(name, "cancel_return_to_dock")

    async def _dock(self, name: str, mode: int | None, charge_state: int | None) -> None:
        if charge_state != 0:
            return

        if mode == WorkMode.MODE_WORKING:
            await self._send_command(name, "pause_execute_task")

        if mode == WorkMode.MODE_RETURNING:
            await self._send_command(name, "cancel_return_to_dock")

        await self._send_command(name, "return_to_dock")

    async def _cancel(self, name: str, mode: int | None) -> None:
        if mode == WorkMode.MODE_WORKING:
            await self._send_command(name, "pause_execute_task")
            await self._request_iot_sync(name)
            await self._send_command(name, "cancel_job")
            return
        if mode == WorkMode.MODE_RETURNING:
            await self._send_command(name, "cancel_return_to_dock")
            await self._request_iot_sync(name)
            await self._send_command(name, "cancel_job")
            return
        if mode == WorkMode.MODE_PAUSE:
            await self._send_command(name, "cancel_job")

    async def _request_iot_sync(self, name: str) -> None:
        await self._send_command(
            name,
            "request_iot_sys",
            rpt_act=RptAct.RPT_START,
            rpt_info_type=[
                RptInfoType.RIT_DEV_STA,
                RptInfoType.RIT_DEV_LOCAL,
                RptInfoType.RIT_WORK,
                RptInfoType.RIT_MAINTAIN,
                RptInfoType.RIT_BASESTATION_INFO,
                RptInfoType.RIT_VIO,
            ],
            timeout=10000,
            period=3000,
            no_change_period=4000,
            count=0,
        )

    def _to_state(self, device_name: str, state: Any) -> dict[str, Any]:
        dev = state.report_data.dev
        work = state.report_data.work
        battery = int(getattr(dev, "battery_val", 0) or 0)
        charge_state = int(getattr(dev, "charge_state", 0) or 0)
        sys_status = int(getattr(dev, "sys_status", 0) or 0)
        mode_name = self._mode_name(sys_status)
        service_areas, selected_areas, current_area = self._service_area_state(device_name, state)

        progress = int((getattr(work, "area", 0) or 0) >> 16)

        return {
            "name": state.name,
            "online": bool(state.online),
            "battery": battery,
            "chargeState": charge_state,
            "sysStatus": sys_status,
            "modeName": mode_name,
            "areaProgress": progress,
            "hasError": mode_name == "MODE_LOCK",
            "serviceAreas": service_areas,
            "selectedAreaIds": selected_areas,
            "currentAreaId": current_area,
        }

    def _service_area_state(self, device_name: str, state: Any) -> tuple[list[dict[str, Any]], list[int], int | None]:
        map_data = getattr(state, "map", None)
        if map_data is None:
            return ([{"id": 0, "name": "All Areas"}], [0], None)

        area_name_items = list(getattr(map_data, "area_name", []) or [])
        area_dict = dict(getattr(map_data, "area", {}) or {})

        name_by_hash: dict[int, str] = {}
        for item in area_name_items:
            try:
                hash_id = int(getattr(item, "hash"))
            except Exception:
                continue

            name = str(getattr(item, "name", "")).strip()
            if name:
                name_by_hash[hash_id] = name

        all_hashes: set[int] = set(name_by_hash.keys())
        for hash_id in area_dict.keys():
            try:
                all_hashes.add(int(hash_id))
            except Exception:
                continue

        if len(all_hashes) == 0:
            # Fallback for accounts where cloud map hash sync does not hydrate area hashes.
            # Use scheduled plan tasks as selectable service areas so Home can still expose
            # meaningful room/area names from the Mammotion app.
            plan_by_id = dict(getattr(map_data, "plan", {}) or {})
            plan_names: list[str] = []
            for plan in plan_by_id.values():
                task_name = str(getattr(plan, "task_name", "")).strip()
                job_name = str(getattr(plan, "job_name", "")).strip()
                label = task_name or job_name
                if label:
                    plan_names.append(label)

            # Keep deterministic order and de-duplicate case-insensitively.
            seen: set[str] = set()
            unique_names: list[str] = []
            for name in sorted(plan_names, key=lambda item: item.casefold()):
                key = name.casefold()
                if key in seen:
                    continue
                seen.add(key)
                unique_names.append(name)

            if len(unique_names) > 0:
                service_areas = [{"id": idx + 1, "name": name} for idx, name in enumerate(unique_names)]
                selected = [area["id"] for area in service_areas]
                return (service_areas, selected, None)

            fallback_names = self._configured_area_names(device_name)
            if len(fallback_names) > 0:
                service_areas = [{"id": idx + 1, "name": name} for idx, name in enumerate(fallback_names)]
                selected = [area["id"] for area in service_areas]
                return (service_areas, selected, None)

            return ([{"id": 0, "name": "All Areas"}], [0], None)

        id_map = self._area_id_map.setdefault(device_name, {})
        for hash_id in list(id_map.keys()):
            if hash_id not in all_hashes:
                id_map.pop(hash_id, None)

        next_id = max(id_map.values(), default=0) + 1
        for hash_id in sorted(all_hashes):
            if hash_id not in id_map:
                id_map[hash_id] = next_id
                next_id += 1

        sorted_hashes = sorted(all_hashes, key=lambda hash_id: (name_by_hash.get(hash_id, f"Area {id_map[hash_id]}"), hash_id))
        service_areas = [
            {
                "id": id_map[hash_id],
                "name": name_by_hash.get(hash_id, f"Area {id_map[hash_id]}"),
            }
            for hash_id in sorted_hashes
        ]

        zone_hashes = list(getattr(getattr(state, "work", None), "zone_hashs", []) or [])
        selected_areas = []
        for hash_id in zone_hashes:
            try:
                selected_area_id = id_map.get(int(hash_id))
            except Exception:
                selected_area_id = None

            if selected_area_id is not None:
                selected_areas.append(selected_area_id)

        if len(selected_areas) == 0:
            selected_areas = [area["id"] for area in service_areas]

        current_area = None
        try:
            current_zone_hash = int(getattr(getattr(state, "location", None), "work_zone", 0) or 0)
            if current_zone_hash in id_map:
                current_area = id_map[current_zone_hash]
        except Exception:
            current_area = None

        return (service_areas, selected_areas, current_area)

    @staticmethod
    def _mode_name(value: int) -> str:
        mode = device_mode(value)
        if mode == "Invalid mode":
            return f"UNKNOWN_{value}"
        return mode

    def _configured_area_names(self, device_name: str) -> list[str]:
        names = self.area_name_fallbacks.get(device_name)
        if names and len(names) > 0:
            return names

        names = self.area_name_fallbacks.get("*")
        if names and len(names) > 0:
            return names

        return []

    @staticmethod
    def _debug(message: str) -> None:
        print(message, file=sys.stderr, flush=True)


async def main() -> None:
    bridge = Bridge()

    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break

        line = line.strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
            request_id = payload.get("id")
            method = payload.get("method")
            params = payload.get("params") or {}
            if not isinstance(params, dict):
                raise ValueError("params must be an object")

            data = await bridge.handle(method, params)
            response = {"id": request_id, "ok": True, "data": data}
        except Exception as exc:
            response = {
                "id": payload.get("id") if isinstance(payload, dict) else None,
                "ok": False,
                "error": str(exc),
            }

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
